import type { Config } from '../config.ts';
import { CATALOG, saveProviderKey, autoSetup, slotFor, type AutoReport } from './autodetect.ts';
import { llmSlot } from './settings.ts';

/** Which env var names fill which provider (first one set wins). Only names are ever reported, never values. */
export const ENV_KEYS: Record<string, string[]> = { groq: ['GROQ_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], xai: ['XAI_API_KEY', 'GROK_API_KEY'], mistral: ['MISTRAL_API_KEY'] };
const clean = (v: string) => v.trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();

export function envStatus(env: NodeJS.ProcessEnv = process.env): { provider: string; var: string | null }[] {
  const out = Object.entries(ENV_KEYS).map(([provider, names]) => ({ provider, var: names.find((n) => clean(env[n] ?? '')) ?? null }));
  out.push({ provider: 'ollama', var: env.OLLAMA_BASE_URL ? 'OLLAMA_BASE_URL' : env.OLLAMA === '1' ? 'OLLAMA' : null }); return out;
}

/** Apply keys found in the environment/.env: each provider is detected, a model chosen, tested for real, then saved to the encrypted store. Unchanged keys are skipped unless force. */
export async function applyEnvKeys(cfg: Config, o: { force?: boolean; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {}): Promise<{ provider: string; var: string; skipped?: boolean; report?: AutoReport }[]> {
  const env = o.env ?? process.env; const out: { provider: string; var: string; skipped?: boolean; report?: AutoReport }[] = [];
  for (const s of envStatus(env)) {
    if (!s.var) continue; const c = CATALOG.find((x) => x.id === s.provider)!;
    if (s.provider === 'ollama') { const base = (env.OLLAMA_BASE_URL ? clean(env.OLLAMA_BASE_URL).replace(/\/+$/, '').replace(/(?<!\/v1)$/, '/v1') : c.base); out.push({ provider: 'ollama', var: s.var, report: await autoSetup(cfg, { provider: 'ollama', baseUrl: base, slot: slotFor(cfg, base) }, o.fetchFn) }); continue; }
    const key = clean(env[s.var]!); const n = [1, 2, 3].find((i) => llmSlot(cfg, i)?.baseUrl === c.base);
    if (!o.force && n && llmSlot(cfg, n)?.apiKey === key) { out.push({ provider: s.provider, var: s.var, skipped: true }); continue; }
    out.push({ provider: s.provider, var: s.var, report: await saveProviderKey(cfg, s.provider, key, o.fetchFn) });
  }
  return out;
}
