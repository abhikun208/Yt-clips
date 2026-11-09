import { existsSync } from 'node:fs';
import type { Store } from '../db.ts';
import { loadTranscript } from '../analysis/transcript.ts';
import { run } from '../util/proc.ts';

/** Silent ranges (seconds, relative to the file) from ffmpeg silencedetect; used by the caption silence gate and by `diag-clip`. */
export async function silentRanges(file: string, o: { start?: number; dur?: number; noiseDb?: number; minSec?: number } = {}): Promise<[number, number][]> {
  const args = ['-hide_banner', '-nostats', ...(o.start ? ['-ss', String(o.start)] : []), ...(o.dur ? ['-t', String(o.dur)] : []), '-i', file, '-vn', '-af', `silencedetect=noise=${o.noiseDb ?? -45}dB:d=${o.minSec ?? 0.35}`, '-f', 'null', '-'];
  const r = await run('ffmpeg', args, { timeoutMs: 120_000 }).catch(() => null); if (!r) return [];
  const txt = `${r.stdout}\n${r.stderr}`; const out: [number, number][] = []; let s: number | null = null;
  for (const m of txt.matchAll(/silence_(start|end): (-?[\d.]+)/g)) { const t = Number(m[2]); if (m[1] === 'start') s = Math.max(0, t); else if (s !== null) { out.push([s, t]); s = null; } }
  if (s !== null && o.dur) out.push([s, o.dur]);
  return out;
}

/** One-command truth report for a clip: which transcript file feeds its captions/title, which cues fall in the clip window, whether words have real timing, and where the audio is silent. */
export async function diagClip(store: Store, clipId: number): Promise<string> {
  const L: string[] = [];
  const c = store.get<{ id: number; output_id: string; raw_path: string | null; edited_path: string | null; candidate_id: number }>('SELECT id, output_id, raw_path, edited_path, candidate_id FROM clips WHERE id=?', clipId);
  if (!c) return `clip ${clipId} nahi mila`;
  const k = store.get<{ video_id: number; start_sec: number; end_sec: number; hook: string | null; transcript: string | null }>('SELECT video_id, start_sec, end_sec, hook, transcript FROM candidates WHERE id=?', c.candidate_id);
  const v = k ? store.get<{ path: string; duration: number | null }>('SELECT path, duration FROM videos WHERE id=?', k.video_id) : undefined;
  if (!k || !v) return `clip ${clipId}: candidate/video record nahi mila`;
  const base = v.path.replace(/\.[^.]+$/, '');
  const used = ['.edited.json', '.srt', '.vtt', '.json'].find((e) => existsSync(base + e));
  L.push(`CLIP #${c.id} (${c.output_id})  window in source: ${k.start_sec.toFixed(1)}s -> ${k.end_sec.toFixed(1)}s (${(k.end_sec - k.start_sec).toFixed(1)}s)`);
  L.push(`source: ${v.path}${v.duration ? `  (${(v.duration / 60).toFixed(1)} min)` : ''}`);
  L.push(`transcript file used for captions/title: ${used ? base + used : 'NONE (captions need a live clip-level transcription)'}`);
  const { captionSource } = await import('../sources/ytcaptions.ts'); const csrc = captionSource(base); if (csrc) L.push(`transcript origin: ${csrc} (YouTube's own caption track, not our speech-to-text)`);
  const cues = loadTranscript(base); const inWin = cues.filter((q) => q.end > k.start_sec && q.start < k.end_sec);
  L.push(`cues in whole source: ${cues.length}; cues overlapping this clip: ${inWin.length}`);
  for (const q of inWin.slice(0, 12)) { const w = q.words?.length ?? 0; L.push(`  [${(q.start - k.start_sec).toFixed(2)} -> ${(q.end - k.start_sec).toFixed(2)}] ${w ? `${w} timed words` : 'NO word timing'} | ${q.text.slice(0, 80)}`); }
  const long = inWin.filter((q) => q.end - q.start > 12); if (long.length) L.push(`WARNING: ${long.length} cue(s) longer than 12 s -> captions inside them are spread evenly, not real timing`);
  const nw = inWin.reduce((a, q) => a + (q.words?.length ?? 0), 0); L.push(`timed words in window: ${nw}  (0 = captions are only estimated)`);
  L.push(`title/hook text: ${k.hook ?? '-'}`); L.push(`candidate transcript: ${(k.transcript ?? '-').slice(0, 160)}`);
  const f = c.edited_path && existsSync(c.edited_path) ? c.edited_path : c.raw_path && existsSync(c.raw_path) ? c.raw_path : null;
  if (f) { const sr = await silentRanges(f); L.push(`silent ranges in ${f.split('/').pop()}: ${sr.length ? sr.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}s`).join(', ') : 'none'}`); }
  return L.join('\n');
}
