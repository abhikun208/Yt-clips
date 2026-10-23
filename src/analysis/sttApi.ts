import { readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Cue, Word } from './transcript.ts';
import type { AiCreds } from '../ai/settings.ts';
import { run } from '../util/proc.ts';

interface ApiWord { word?: string; start: number; end: number }
interface ApiSeg { start: number; end: number; text: string; words?: ApiWord[] }
export interface ApiResp { language?: string; text?: string; segments?: ApiSeg[]; words?: ApiWord[] }

/** Map an OpenAI-style verbose_json response (top-level `words` and/or per-segment words) onto cues with real word timing. Pure. */
export function cuesFromApi(r: ApiResp, offset = 0): Cue[] {
  const allWords: Word[] = [...(r.words ?? []), ...(r.segments ?? []).flatMap((s) => s.words ?? [])]
    .map((w) => ({ start: w.start + offset, end: w.end + offset, text: String(w.word ?? '').trim() })).filter((w) => Number.isFinite(w.start) && w.end > w.start && w.text);
  const seen = new Set<string>(); const uniq = allWords.filter((w) => { const k = `${w.start.toFixed(3)}|${w.text}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.start - b.start);
  const cues: Cue[] = [];
  for (const s of r.segments ?? []) {
    const start = s.start + offset, end = s.end + offset, text = String(s.text ?? '').trim();
    if (!Number.isFinite(start) || end <= start || !text) continue;
    const words = uniq.filter((w) => w.start >= start - 0.05 && w.start < end);
    cues.push({ start, end, text, ...(words.length ? { words } : {}) });
  }
  if (!cues.length && uniq.length) { // no segments: group words into ~6s cues
    let cur: Word[] = []; const flush = () => { if (cur.length) { cues.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.text).join(' '), words: cur }); cur = []; } };
    for (const w of uniq) { if (cur.length && w.end - cur[0]!.start > 6) flush(); cur.push(w); } flush();
  }
  return cues;
}

const CODECS = [{ codec: 'libopus', ext: 'ogg', br: '24k' }, { codec: 'libmp3lame', ext: 'mp3', br: '32k' }, { codec: 'aac', ext: 'm4a', br: '32k' }];
async function callOnce(c: AiCreds, file: string, language: string, prompt: string, fetchFn: typeof fetch): Promise<ApiResp> {
  const fd = new FormData(); fd.append('file', new Blob([readFileSync(file)]), `audio.${file.split('.').pop()}`); fd.append('model', c.model); fd.append('response_format', 'verbose_json'); fd.append('temperature', '0');
  fd.append('timestamp_granularities[]', 'word'); fd.append('timestamp_granularities[]', 'segment'); if (language && language !== 'auto') fd.append('language', language); if (prompt) fd.append('prompt', prompt.slice(0, 600));
  for (let a = 0; ; a++) {
    const r = await fetchFn(`${c.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${c.apiKey}` }, body: fd, signal: AbortSignal.timeout(5 * 60_000) });
    if (r.ok) return (await r.json()) as ApiResp;
    if ((r.status === 429 || r.status >= 500) && a < 4) { const ra = Number(r.headers.get('retry-after')); await new Promise((ok) => setTimeout(ok, Math.min(60_000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** a)))); continue; }
    const body = await r.text().catch(() => ''); if (r.status === 401) throw new Error('AUTH_REVOKED: STT API key rejected');
    throw new Error(`stt api HTTP ${r.status}: ${body.slice(0, 160)}`);
  }
}

/**
 * Transcribe through an OpenAI-compatible /audio/transcriptions endpoint (Groq free tier by default).
 * Audio is cut into `chunkSec` pieces (16 kHz mono Opus, tiny files) so each request stays far below the 25 MB free-tier limit; word times are offset back to the full timeline.
 */
export async function transcribeViaApi(videoPath: string, tmpDir: string, c: AiCreds, o: { language?: string; prompt?: string; chunkSec?: number; fetchFn?: typeof fetch } = {}): Promise<{ cues: Cue[]; language?: string }> {
  mkdirSync(tmpDir, { recursive: true }); const chunk = o.chunkSec ?? 600; const fetchFn = o.fetchFn ?? fetch;
  const dur = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { timeoutMs: 60_000 }); const total = Number(dur.stdout.trim());
  if (!Number.isFinite(total) || total <= 0) throw new Error('could not read duration');
  const cues: Cue[] = []; let language: string | undefined; const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  for (let t = 0, i = 0; t < total; t += chunk, i++) {
    let f = '';
    try {
      let ok = false; let lastErr = '';
      for (const k of CODECS) { // phones' ffmpeg builds differ: use the first encoder that works
        f = join(tmpDir, `stt_${tag}_${i}.${k.ext}`);
        const ex = await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-t', String(chunk), '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', k.codec, '-b:a', k.br, f], { timeoutMs: 10 * 60_000 });
        if (ex.code === 0 && existsSync(f)) { ok = true; break; } lastErr = ex.stderr.slice(0, 120); rmSync(f, { force: true });
      }
      if (!ok) throw new Error(`audio extraction failed: ${lastErr}`);
      const resp = await callOnce(c, f, o.language ?? 'auto', o.prompt ?? '', fetchFn); language ||= resp.language; cues.push(...cuesFromApi(resp, t));
    } finally { if (f) rmSync(f, { force: true }); }
  }
  cues.sort((a, b) => a.start - b.start); return { cues, language };
}
