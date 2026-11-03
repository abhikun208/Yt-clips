import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { Cue } from './transcript.ts';
import { run } from '../util/proc.ts';

/**
 * Timing repair for captions whose timing is only approximate (Gemini audio fallback). Two steps, both local:
 *  1) optional `stable-ts` forced alignment (tools/align.py) when that package is installed (needs a whisper model: PC/VPS);
 *  2) always: speech-region snapping with ffmpeg `silencedetect` - cue edges move to the nearest real speech onset/offset (<= 1.5 s away)
 *     and per-word times are spread over the SPEECH time only (pauses get no words), which is what karaoke highlighting needs.
 * It is an acoustic correction, not recognition: text is never changed.
 */
export interface Region { start: number; end: number }
export function parseSilences(stderr: string, total: number): Region[] {
  const sil: Region[] = []; let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const a = /silence_start:\s*(-?[\d.]+)/.exec(line); if (a) open = Math.max(0, Number(a[1]));
    const b = /silence_end:\s*(-?[\d.]+)/.exec(line); if (b && open !== null) { sil.push({ start: open, end: Number(b[1]) }); open = null; }
  }
  if (open !== null) sil.push({ start: open, end: total });
  const speech: Region[] = []; let t = 0;
  for (const s of sil) { if (s.start - t > 0.12) speech.push({ start: t, end: s.start }); t = Math.max(t, s.end); }
  if (total - t > 0.12) speech.push({ start: t, end: total });
  return speech;
}
export async function speechRegions(videoPath: string, total: number, noiseDb = -32): Promise<Region[]> {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', videoPath, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=0.18`, '-f', 'null', '-'], { timeoutMs: 10 * 60_000 });
  return parseSilences(r.stderr, total);
}
const nearest = (v: number, cands: number[], maxD: number): number => { let best = v, bd = maxD; for (const c of cands) { const d = Math.abs(c - v); if (d <= bd) { bd = d; best = c; } } return best; };
export function snapCues(cues: Cue[], speech: Region[], maxMove = 1.5): Cue[] {
  if (!speech.length) return cues;
  const starts = speech.map((s) => s.start), ends = speech.map((s) => s.end); const out: Cue[] = []; let prevEnd = 0;
  for (const c of cues) {
    let a = nearest(c.start, starts, maxMove), b = nearest(c.end, ends, maxMove);
    if (b <= a + 0.2) { a = c.start; b = c.end; }
    a = Math.max(a, prevEnd); if (b <= a + 0.15) b = a + Math.max(0.3, c.end - c.start);
    const ws = c.text.split(/\s+/).filter(Boolean); const regs = speech.map((s) => ({ start: Math.max(s.start, a), end: Math.min(s.end, b) })).filter((s) => s.end - s.start > 0.05);
    const speechTime = regs.reduce((x, s) => x + (s.end - s.start), 0); let words = c.words;
    if (ws.length && speechTime > 0.2) { // spread words over speech time, weight = letters (+1 so short words are not instant)
      const wts = ws.map((w) => w.length + 1), tot = wts.reduce((x, y) => x + y, 0); let acc = 0; words = [];
      const at = (u: number): number => { let rem = u; for (const s of regs) { const len = s.end - s.start; if (rem <= len) return s.start + rem; rem -= len; } return regs[regs.length - 1]!.end; };
      ws.forEach((w, i) => { const w0 = at((acc / tot) * speechTime); acc += wts[i]!; const w1 = at((acc / tot) * speechTime); words!.push({ start: w0, end: Math.max(w1, w0 + 0.05), text: w }); });
    }
    out.push({ ...c, start: a, end: b, ...(words ? { words } : {}) }); prevEnd = b;
  }
  return out;
}
/** stable-ts forced alignment (optional). Returns null when the package/model is not available or anything fails. */
export async function alignWithStableTs(rootDir: string, wav: string, cues: Cue[], lang: string): Promise<Cue[] | null> {
  const probe = await run('python3', ['-I', '-c', 'import stable_whisper'], { timeoutMs: 30_000 }).catch(() => null); if (!probe || probe.code !== 0) return null;
  const r = await run('python3', ['-I', join(rootDir, 'tools', 'align.py'), wav, lang, JSON.stringify(cues.map((c) => ({ start: c.start, end: c.end, text: c.text })))], { timeoutMs: 30 * 60_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  try { const j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { segments?: { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }[] }; if (!j.segments?.length) return null;
    return j.segments.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).map((s) => ({ start: s.start, end: s.end, text: s.text.trim(), ...(s.words?.length ? { words: s.words.map((w) => ({ start: w.start, end: w.end, text: w.word.trim() })).filter((w) => w.text && w.end > w.start) } : {}) }));
  } catch { return null; }
}
/** Full repair used by the Gemini fallback. */
export async function refineApproxCues(rootDir: string, tmpDir: string, videoPath: string, cues: Cue[], lang: string, total: number): Promise<{ cues: Cue[]; how: string }> {
  const wav = join(tmpDir, `align_${Date.now()}.wav`);
  try {
    const ex = await run('ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', wav], { timeoutMs: 10 * 60_000 });
    if (ex.code === 0) { const st = await alignWithStableTs(rootDir, wav, cues, lang); if (st?.length) return { cues: st, how: 'stable-ts alignment' }; }
  } finally { rmSync(wav, { force: true }); }
  const sp = await speechRegions(videoPath, total).catch(() => []);
  // guard: loud music / continuous noise leaves no real pauses (speech regions cover almost everything) or none at all → snapping would only guess, so the cues stay as they are
  const covered = sp.reduce((x, r) => x + (r.end - r.start), 0) / Math.max(1, total); if (sp.length < 2 || covered > 0.93) return { cues, how: 'unchanged (no clear pauses: noisy/music audio)' };
  return { cues: snapCues(cues, sp), how: 'speech-snap' };
}
