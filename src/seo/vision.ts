import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../util/proc.ts';
import { adaptForHost } from '../ai/health.ts';
import type { LlmEnv } from './llm.ts';

/** Models that accept images through the OpenAI-compatible API. Conservative name match: a text-only model is never sent an image. */
export const isVisionModel = (model: string): boolean => /gemini|gpt-4o|gpt-4\.1|gpt-5|llava|bakllava|moondream|minicpm-v|vision|llama-4|llama-3\.2-\d+b-vision|qwen.*vl|pixtral|claude/i.test(model);

/** Three small JPEG frames (15 % / 50 % / 85 % of the clip) as base64. Empty on any failure: vision is an extra, never a requirement. */
/** Own machine (Ollama / LM Studio / vLLM on localhost or a private IP): no quota, so the daily image budget does not apply. */
export const isLocalEndpoint = (baseUrl: string): boolean => { try { const h = new URL(baseUrl).hostname; return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|host\.docker\.internal$)/.test(h); } catch { return false; } };

export async function clipFrames(path: string, durationSec: number): Promise<string[]> {
  if (!(durationSec > 1)) return [];
  const dir = await mkdtemp(join(tmpdir(), 'ytc-vis-')); const out: string[] = [];
  try {
    for (const f of [0.15, 0.5, 0.85]) {
      const file = join(dir, `${f}.jpg`);
      const r = await run('ffmpeg', ['-v', 'error', '-ss', String((durationSec * f).toFixed(2)), '-i', path, '-frames:v', '1', '-vf', 'scale=384:-2', '-q:v', '5', '-y', file], { timeoutMs: 20_000 });
      if (r.code === 0) out.push((await readFile(file)).toString('base64'));
    }
  } catch { /* none */ } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  return out;
}

/**
 * Ask a vision-capable provider what is actually on screen. The answer (plain text, <= 300 chars) becomes a hint for the
 * title prompt, so ANY text provider can then write a title about the real moment (useful for silent, dance or gaming clips).
 * Returns null when no frame / no answer; nothing here can fail a clip.
 */
/** A vision 429/error pauses vision for that provider for 1 h. It is kept OUT of the shared LLM health registry on purpose: an image quota must not cool down the same provider's text titles. */
const visionPause = new Map<string, number>();
export const resetVisionPause = () => visionPause.clear();
export async function describeFrames(env: LlmEnv, frames: string[], fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (!frames.length || !isVisionModel(env.model)) return null;
  const pk = `${env.baseUrl}|${env.model}`; if ((visionPause.get(pk) ?? 0) > Date.now()) return null;
  try {
    const content = [{ type: 'text', text: 'These are 3 frames from one short video (start, middle, end). In at most 2 plain sentences say what is visibly happening and which moment is the most striking or emotional. Describe only what you can see; do not guess names.' }, ...frames.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } }))];
    const res = await fetchFn(`${env.baseUrl}/chat/completions`, adaptForHost(`${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(isLocalEndpoint(env.baseUrl) ? 180_000 : 25_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.2, max_tokens: 200, messages: [{ role: 'user', content }] }) }));
    if (!res.ok) { if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) visionPause.set(pk, Date.now() + 3_600_000); return null; }
    const txt = String(((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return txt.length >= 10 ? txt : null;
  } catch { return null; }
}
