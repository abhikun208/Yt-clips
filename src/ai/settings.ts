import { join } from 'node:path';
import type { Config } from '../config.ts';
import { SecretStore } from '../publish/secrets.ts';

/** Free defaults: Groq's OpenAI-compatible API (whisper-large-v3-turbo for speech, a Llama model for text). Any OpenAI-compatible endpoint works. */
export const DEFAULT_BASE = 'https://api.groq.com/openai/v1';
export const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
export const DEFAULT_LLM_MODEL = 'llama-3.3-70b-versatile';
/** Provider presets (OpenAI-compatible). Base URLs come from each provider's public docs; NONE were called live from this project, so treat them as starting points. Free tiers/limits change: check the provider. */
export const PRESETS = [
  { id: 'groq', label: 'Groq (free tier, key needed)', base: 'https://api.groq.com/openai/v1', llm: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3-turbo', needsKey: true, verified: 'docs read 2026-10-25 (also: openai/gpt-oss-20b, llama-3.1-8b-instant, whisper-large-v3)' },
  { id: 'gemini', label: 'Google Gemini (OpenAI-compat, free tier, key needed)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', llm: 'gemini-3.8-flash', stt: '', needsKey: true, verified: 'base URL + model id read from Google docs 2026-10-25; model ids change often, use Models dikhao' },
  { id: 'xai', label: 'xAI Grok (paid credits, key needed)', base: 'https://api.x.ai/v1', llm: 'grok-3-mini', stt: '', needsKey: true, verified: 'base URL read 2026-10-25; model ids change: use Auto setup' },
  { id: 'openrouter', label: 'OpenRouter (":free" models, key needed)', base: 'https://openrouter.ai/api/v1', llm: 'meta-llama/llama-3.3-70b-instruct:free', stt: '', needsKey: true, verified: 'openrouter/free router id read 2026-10-25 (picks any free model); ":free" suffix = free variants' },
  { id: 'mistral', label: 'Mistral (free tier, key needed)', base: 'https://api.mistral.ai/v1', llm: 'mistral-small-latest', stt: '', needsKey: true, verified: 'unverified' },
  { id: 'cerebras', label: 'Cerebras (free tier)', base: 'https://api.cerebras.ai/v1', llm: 'llama-3.3-70b', stt: '', needsKey: true, verified: 'base URL from the provider docs; NOT called live by the author — use Auto setup (it tests the key for real)' },
  { id: 'sambanova', label: 'SambaNova (free tier)', base: 'https://api.sambanova.ai/v1', llm: 'Meta-Llama-3.3-70B-Instruct', stt: '', needsKey: true, verified: 'base URL from the provider docs; NOT called live by the author — use Auto setup (it tests the key for real)' },
  { id: 'nvidia', label: 'NVIDIA NIM (free credits)', base: 'https://integrate.api.nvidia.com/v1', llm: 'meta/llama-3.3-70b-instruct', stt: '', needsKey: true, verified: 'base URL from the provider docs; NOT called live by the author — use Auto setup (it tests the key for real)' },
  { id: 'huggingface', label: 'Hugging Face Inference (free credits)', base: 'https://router.huggingface.co/v1', llm: 'meta-llama/Llama-3.3-70B-Instruct', stt: '', needsKey: true, verified: 'base URL from the provider docs; NOT called live by the author — use Auto setup (it tests the key for real)' },
  { id: 'deepseek', label: 'DeepSeek (very cheap, paid)', base: 'https://api.deepseek.com/v1', llm: 'deepseek-chat', stt: '', needsKey: true, verified: 'base URL from the provider docs; NOT called live by the author — use Auto setup (it tests the key for real)' },
  { id: 'openai', label: 'OpenAI (paid)', base: 'https://api.openai.com/v1', llm: 'gpt-4o-mini', stt: 'whisper-1', needsKey: true, verified: 'base URL from the provider docs; NOT called live by the author — use Auto setup (it tests the key for real)' },
  { id: 'together', label: 'Together AI (paid credits)', base: 'https://api.together.xyz/v1', llm: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', stt: '', needsKey: true, verified: 'base URL from the provider docs; NOT called live by the author — use Auto setup (it tests the key for real)' },
  { id: 'ollama', label: 'Ollama on this machine (NO key, fully free/offline)', base: 'http://127.0.0.1:11434/v1', llm: 'llama3.2', stt: '', needsKey: false, verified: 'base URL + /v1/models read 2026-10-25; run `ollama pull llama3.2` first' },
  { id: 'lmstudio', label: 'LM Studio local server (NO key)', base: 'http://127.0.0.1:1234/v1', llm: 'local-model', stt: '', needsKey: false, verified: 'unverified (fake-server tested only)' },
] as const;
/** Loopback / private-network endpoints need no API key. */
export function isLocalBase(base: string): boolean {
  try { const h = new URL(base).hostname; return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h); } catch { return false; }
}
export interface AiCreds { baseUrl: string; apiKey: string; model: string }
const store = (cfg: Config) => SecretStore.forData(cfg.dataDir);
type Raw = { api_key?: string; base_url?: string; model?: string };

function pick(cfg: Config, kind: 'stt' | 'llm', slot = 1): AiCreds | null {
  const E = process.env; const up = kind.toUpperCase();
  let raw: Raw | null = null; try { raw = store(cfg).read<Raw>(slot === 1 ? `ai-${kind}` : `ai-${kind}-${slot}`); } catch { raw = null; }
  const envOk = slot === 1;
  const apiKey = (envOk && E[`${up}_API_KEY`]) || raw?.api_key || '';
  const baseUrl = ((envOk && (E[`${up}_API_BASE`] || (kind === 'llm' && E.LLM_BASE_URL))) || raw?.base_url || (apiKey ? DEFAULT_BASE : '')).replace(/\/+$/, '');
  if (!baseUrl) return null;
  if (kind === 'stt' && /:11434(\/|$)/.test(baseUrl)) return null; // Ollama has no speech-to-text endpoint: a saved Ollama URL in the STT slot is a misconfiguration, never used
  if (!apiKey && !isLocalBase(baseUrl)) return null; // remote endpoints need a key; local ones do not
  return { apiKey, baseUrl, model: (envOk && (E[`${up}_API_MODEL`] || (kind === 'llm' ? E.LLM_MODEL : ''))) || raw?.model || (kind === 'stt' ? DEFAULT_STT_MODEL : DEFAULT_LLM_MODEL) };
}
export const sttCreds = (cfg: Config) => pick(cfg, 'stt');
export const llmCreds = (cfg: Config) => pick(cfg, 'llm');
export const llmSlot = (cfg: Config, slot: number) => pick(cfg, 'llm', slot);
/** Ordered fallback chain: slot 1 (primary), then 2 and 3. Callers try each until one works. */
export const MAX_SLOTS = 6;
export const SLOT_LIST = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1);
export const llmChain = (cfg: Config): AiCreds[] => SLOT_LIST.map((n) => pick(cfg, 'llm', n)).filter((x): x is AiCreds => !!x);

export function saveAi(cfg: Config, kind: 'stt' | 'llm', v: { apiKey?: string; baseUrl?: string; model?: string; slot?: number }): void {
  const local = !!v.baseUrl && isLocalBase(v.baseUrl);
  if (!v.apiKey && !local) throw new Error('invalid: apiKey required (only localhost/LAN endpoints such as Ollama work without a key)');
  if (v.apiKey && (v.apiKey.length < 8 || v.apiKey.length > 512)) throw new Error('invalid: apiKey length');
  if (v.baseUrl && !/^https?:\/\/[^\s]+$/.test(v.baseUrl)) throw new Error('invalid: baseUrl must be http(s)://...');
  if (v.model && !/^[\w./:-]{1,80}$/.test(v.model)) throw new Error('invalid: model name');
  const slot = v.slot ?? 1; if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) throw new Error(`invalid: slot 1-${MAX_SLOTS}`);
  store(cfg).write(slot === 1 ? `ai-${kind}` : `ai-${kind}-${slot}`, { ...(v.apiKey ? { api_key: v.apiKey } : {}), ...(v.baseUrl ? { base_url: v.baseUrl } : {}), ...(v.model ? { model: v.model } : {}) });
}
/** Status without secrets. */
export function aiStatus(cfg: Config) { const s = sttCreds(cfg), l = llmCreds(cfg); return { stt: s ? { ready: true, base: s.baseUrl, model: s.model } : { ready: false }, llm: l ? { ready: true, base: l.baseUrl, model: l.model, keyless: !l.apiKey } : { ready: false }, slots: SLOT_LIST.map((n) => { const c = pick(cfg, 'llm', n); return c ? { slot: n, base: c.baseUrl, model: c.model, keyless: !c.apiKey } : null; }), chain: llmChain(cfg).map((c) => ({ base: c.baseUrl, model: c.model, keyless: !c.apiKey })), presets: PRESETS }; }
