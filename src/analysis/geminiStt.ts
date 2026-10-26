import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/proc.ts';
import type { Cue } from './transcript.ts';
import type { AiCreds } from '../ai/settings.ts';

/**
 * Speech-to-text through a Gemini key via the OpenAI-compatible chat endpoint (`input_audio`). Fallback for when no Whisper engine is installed.
 * APPROXIMATE timing (segment level, model-estimated, no per-word times): good for captions/clip ranking, not frame-accurate lip-sync.
 * Audio is cut into short chunks so the model's timestamps stay close to real; times are offset back to the full timeline.
 */
export const GEMINI_CHUNK_SEC = 90;
export function parseGeminiSegments(text: string, offset: number, chunkLen: number): Cue[] {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''); let arr: unknown;
  try { arr = JSON.parse(t); } catch { const m = /\[[\s\S]*\]/.exec(t); if (!m) return []; try { arr = JSON.parse(m[0]); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const cues: Cue[] = [];
  for (const x of arr as { start?: unknown; end?: unknown; text?: unknown }[]) {
    const a = Number(x.start), b = Number(x.end), tx = String(x.text ?? '').trim();
    if (!Number.isFinite(a) || !Number.isFinite(b) || !tx || a < 0 || a > chunkLen + 2) continue;
    cues.push({ start: offset + a, end: offset + Math.min(Math.max(b, a + 0.3), chunkLen + 1), text: tx });
  }
  return cues;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function transcribeViaGemini(videoPath: string, tmpDir: string, c: AiCreds, o: { language?: string; chunkSec?: number; fetchFn?: typeof fetch; gapMs?: number } = {}): Promise<{ cues: Cue[]; language?: string }> {
  mkdirSync(tmpDir, { recursive: true }); const chunk = o.chunkSec ?? GEMINI_CHUNK_SEC; const fetchFn = o.fetchFn ?? fetch;
  const dur = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { timeoutMs: 60_000 }); const total = Number(dur.stdout.trim());
  if (!Number.isFinite(total) || total <= 0) throw new Error('could not read duration');
  const cues: Cue[] = []; const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; let failed = 0, chunks = 0;
  const lang = o.language && o.language !== 'auto' ? ` The language is "${o.language}".` : ' The speech may be Hindi/Hinglish/English; write Hindi in Roman (Hinglish) letters.';
  const prompt = `Transcribe the speech in this audio exactly (gameplay commentary; keep slang like booyah, headshot, clutch).${lang} Reply with ONLY a JSON array: [{"start":<seconds from start of this audio>,"end":<seconds>,"text":"..."}]. Segments 1-6 seconds long, in order. If there is no speech reply [].`;
  for (let t = 0, i = 0; t < total; t += chunk, i++) {
    const f = join(tmpDir, `gstt_${tag}_${i}.mp3`);
    try {
      const ex = await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-t', String(chunk), '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', f], { timeoutMs: 5 * 60_000 });
      if (ex.code !== 0 || !existsSync(f)) throw new Error(`audio extraction failed: ${ex.stderr.slice(0, 100)}`);
      const body = JSON.stringify({ model: c.model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: readFileSync(f).toString('base64'), format: 'mp3' } }] }] });
      let done = false; chunks++;
      for (let attempt = 0; attempt < 4 && !done; attempt++) {
        const r = await fetchFn(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` }, body, signal: AbortSignal.timeout(120_000) });
        if (r.status === 429 || r.status >= 500) { await sleep(o.gapMs === undefined ? 5000 * (attempt + 1) : 1); continue; }
        if (r.status === 401 || r.status === 403) throw new Error(`gemini key rejected (HTTP ${r.status})`);
        if (!r.ok) throw new Error(`gemini HTTP ${r.status}`);
        const j = await r.json() as { choices?: { message?: { content?: string } }[] }; cues.push(...parseGeminiSegments(String(j.choices?.[0]?.message?.content ?? ''), t, Math.min(chunk, total - t))); done = true;
      }
      if (!done) failed++;
    } finally { rmSync(f, { force: true }); }
    await sleep(o.gapMs ?? 4000); // free-tier requests-per-minute
  }
  if (chunks && failed === chunks) throw new Error('gemini busy/limited for every chunk (retry later)');
  cues.sort((a, b) => a.start - b.start); return { cues };
}
