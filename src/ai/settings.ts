import { join } from 'node:path';
import type { Config } from '../config.ts';
import { SecretStore } from '../publish/secrets.ts';

/** Free defaults: Groq's OpenAI-compatible API (whisper-large-v3-turbo for speech, a Llama model for text). Any OpenAI-compatible endpoint works. */
export const DEFAULT_BASE = 'https://api.groq.com/openai/v1';
export const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
export const DEFAULT_LLM_MODEL = 'llama-3.3-70b-versatile';
export interface AiCreds { baseUrl: string; apiKey: string; model: string }
const store = (cfg: Config) => new SecretStore(join(cfg.dataDir, 'secrets'));
type Raw = { api_key?: string; base_url?: string; model?: string };

function pick(cfg: Config, kind: 'stt' | 'llm'): AiCreds | null {
  const E = process.env; const up = kind.toUpperCase();
  let raw: Raw | null = null; try { raw = store(cfg).read<Raw>(`ai-${kind}`); } catch { raw = null; }
  const apiKey = E[`${up}_API_KEY`] || raw?.api_key || ''; if (!apiKey) return null;
  const baseUrl = (E[`${up}_API_BASE`] || E.LLM_BASE_URL && kind === 'llm' && E.LLM_BASE_URL || raw?.base_url || DEFAULT_BASE).replace(/\/+$/, '');
  return { apiKey, baseUrl, model: E[`${up}_API_MODEL`] || (kind === 'llm' ? E.LLM_MODEL : '') || raw?.model || (kind === 'stt' ? DEFAULT_STT_MODEL : DEFAULT_LLM_MODEL) };
}
export const sttCreds = (cfg: Config) => pick(cfg, 'stt');
export const llmCreds = (cfg: Config) => pick(cfg, 'llm');

export function saveAi(cfg: Config, kind: 'stt' | 'llm', v: { apiKey?: string; baseUrl?: string; model?: string }): void {
  if (!v.apiKey || v.apiKey.length < 8 || v.apiKey.length > 512) throw new Error('invalid: apiKey length');
  if (v.baseUrl && !/^https?:\/\/[^\s]+$/.test(v.baseUrl)) throw new Error('invalid: baseUrl must be http(s)://...');
  if (v.model && !/^[\w./:-]{1,80}$/.test(v.model)) throw new Error('invalid: model name');
  store(cfg).write(`ai-${kind}`, { api_key: v.apiKey, ...(v.baseUrl ? { base_url: v.baseUrl } : {}), ...(v.model ? { model: v.model } : {}) });
}
/** Status without secrets. */
export function aiStatus(cfg: Config) { const s = sttCreds(cfg), l = llmCreds(cfg); return { stt: s ? { ready: true, base: s.baseUrl, model: s.model } : { ready: false }, llm: l ? { ready: true, base: l.baseUrl, model: l.model } : { ready: false } }; }
