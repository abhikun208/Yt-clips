import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, which } from '../util/proc.ts';

/**
 * Optional free text-to-speech (narration / voice-over). Providers, first that works wins:
 *  1. `edge-tts` CLI (pip install edge-tts; free Microsoft voices, needs internet, NO key)
 *  0. (opt-in) a local VoiceStudio server: set YT_CLIPS_VOICESTUDIO_URL=http://127.0.0.1:<port>; tried first via the OpenAI-style `POST /v1/audio/speech` route. UNVERIFIED against the real app (its API doc was not reachable from the build sandbox) - on any error it silently falls through to the providers below.
 *  2. `piper` CLI + a local voice model (fully offline) via PIPER_MODEL=/path/to/voice.onnx
 * Output is cached by hash(text+voice+speed). Returns null (never throws) when no provider is installed.
 */
export interface TtsOpts { voice?: string; speed?: number; lang?: 'hi' | 'hinglish' | 'en'; fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv }
export const DEFAULT_VOICE: Record<string, string> = { hi: 'hi-IN-SwaraNeural', hinglish: 'en-IN-NeerjaNeural', en: 'en-US-AriaNeural' };

export async function ttsProviders(): Promise<{ edge: boolean; piper: boolean }> { return { edge: await which('edge-tts'), piper: !!process.env.PIPER_MODEL && (await which('piper')) }; }

export async function synthesize(text: string, dir: string, o: TtsOpts = {}): Promise<{ path: string; provider: string } | null> {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 1500); if (!t) return null;
  const voice = o.voice ?? DEFAULT_VOICE[o.lang ?? 'hinglish']!; const speed = Math.min(1.5, Math.max(0.7, o.speed ?? 1));
  const key = createHash('sha256').update(`${t}|${voice}|${speed}`).digest('hex').slice(0, 20); mkdirSync(dir, { recursive: true });
  const out = join(dir, `tts_${key}.mp3`); if (existsSync(out) && statSync(out).size > 500) return { path: out, provider: 'cache' };
  const vs = (o.env ?? process.env).YT_CLIPS_VOICESTUDIO_URL?.replace(/\/+$/, '');
  if (vs) {
    try {
      const r = await (o.fetchFn ?? fetch)(`${vs}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tts-1', input: t, voice: (o.env ?? process.env).YT_CLIPS_VOICESTUDIO_VOICE || 'alloy', speed, response_format: 'mp3' }), signal: AbortSignal.timeout(120_000) });
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 500) { writeFileSync(out, b); return { path: out, provider: 'voicestudio' }; } }
    } catch { /* fall through to edge-tts / piper */ }
  }
  const p = await ttsProviders();
  if (p.edge) {
    const rate = `${speed >= 1 ? '+' : '-'}${Math.round(Math.abs(speed - 1) * 100)}%`;
    const r = await run('edge-tts', ['--voice', voice, `--rate=${rate}`, '--text', t, '--write-media', out], { timeoutMs: 120_000 }).catch(() => null);
    if (r && r.code === 0 && existsSync(out) && statSync(out).size > 500) return { path: out, provider: 'edge-tts' };
  }
  if (p.piper) {
    const wav = out.replace(/\.mp3$/, '.wav'); const r = await run('piper', ['--model', process.env.PIPER_MODEL!, '--output_file', wav], { input: t, timeoutMs: 120_000 }).catch(() => null);
    if (r && r.code === 0 && existsSync(wav)) { const c = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-q:a', '3', out], { timeoutMs: 60_000 }); if (c.code === 0 && existsSync(out)) return { path: out, provider: 'piper' }; }
  }
  return null;
}
