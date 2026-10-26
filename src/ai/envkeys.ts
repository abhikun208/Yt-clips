import type { Config } from '../config.ts';
import { CATALOG, saveProviderKey, autoSetup, slotFor, type AutoReport } from './autodetect.ts';
import { llmSlot, SLOT_LIST } from './settings.ts';

/** Which env var names fill which provider (first one set wins). Only names are ever reported, never values. */
export const ENV_KEYS: Record<string, string[]> = { groq: ['GROQ_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], xai: ['XAI_API_KEY', 'GROK_API_KEY'], mistral: ['MISTRAL_API_KEY'] };
const clean = (v: string) => v.trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();

const SUFFIXES = ['', '_2', '_3', '_4', '_5'];
/** Every env variable that carries a key. Extra keys for one provider: GEMINI_API_KEY_2, GEMINI_API_KEY_3 ... (each gets its own fallback slot). */
export function envStatus(env: NodeJS.ProcessEnv = process.env): { provider: string; var: string | null; extra?: boolean }[] {
  const out: { provider: string; var: string | null; extra?: boolean }[] = [];
  for (const [provider, names] of Object.entries(ENV_KEYS)) { const base = names[0]!; for (const suf of SUFFIXES) { const v = suf ? base + suf : names.find((n) => clean(env[n] ?? '')); if (v && clean(env[v] ?? '')) out.push({ provider, var: v, extra: !!suf }); } }
  out.push({ provider: 'ollama', var: env.OLLAMA_BASE_URL ? 'OLLAMA_BASE_URL' : env.OLLAMA === '1' ? 'OLLAMA' : null }); return out;
}

/** Apply keys found in the environment/.env: each is detected, a model chosen, tested for real and saved to the encrypted store. Unchanged keys are skipped unless force. Failing keys never occupy a slot. */
export async function applyEnvKeys(cfg: Config, o: { force?: boolean; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {}): Promise<{ provider: string; var: string; skipped?: boolean; report?: AutoReport }[]> {
  const env = o.env ?? process.env; const out: { provider: string; var: string; skipped?: boolean; report?: AutoReport }[] = [];
  for (const s of envStatus(env)) {
    if (!s.var) continue; const c = CATALOG.find((x) => x.id === s.provider)!;
    if (s.provider === 'ollama') { const base = (env.OLLAMA_BASE_URL ? clean(env.OLLAMA_BASE_URL).replace(/\/+$/, '').replace(/(?<!\/v1)$/, '/v1') : c.base); out.push({ provider: 'ollama', var: s.var, report: await autoSetup(cfg, { provider: 'ollama', baseUrl: base, slot: slotFor(cfg, base) }, o.fetchFn) }); continue; }
    const key = clean(env[s.var]!); const n = SLOT_LIST.find((i) => { const x = llmSlot(cfg, i); return x?.baseUrl === c.base && x.apiKey === key; });
    if (!o.force && n) { out.push({ provider: s.provider, var: s.var, skipped: true }); continue; }
    out.push({ provider: s.provider, var: s.var, report: await saveProviderKey(cfg, s.provider, key, o.fetchFn, true) });
  }
  return out;
}
