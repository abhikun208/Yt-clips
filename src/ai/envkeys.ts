import type { Config } from '../config.ts';
import { CATALOG, saveProviderKey, autoSetup, slotFor, providerFromKey, type AutoReport } from './autodetect.ts';
import { llmSlot, SLOT_LIST } from './settings.ts';

/** Which env var names fill which provider (first one set wins). Only names are ever reported, never values. */
export const ENV_KEYS: Record<string, string[]> = { groq: ['GROQ_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], xai: ['XAI_API_KEY', 'GROK_API_KEY'], mistral: ['MISTRAL_API_KEY'], cerebras: ['CEREBRAS_API_KEY'], sambanova: ['SAMBANOVA_API_KEY'], nvidia: ['NVIDIA_API_KEY', 'NGC_API_KEY'], huggingface: ['HF_TOKEN', 'HUGGINGFACE_API_KEY', 'HUGGING_FACE_HUB_TOKEN'], deepseek: ['DEEPSEEK_API_KEY'], openai: ['OPENAI_API_KEY'], together: ['TOGETHER_API_KEY'], llm7: ['LLM7_API_KEY', 'LLM7_TOKEN'], modelscope: ['MODELSCOPE_API_KEY', 'MODELSCOPE_TOKEN'], siliconflow: ['SILICONFLOW_API_KEY'], zai: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY'], nebius: ['NEBIUS_API_KEY'], ai21: ['AI21_API_KEY'] };
const clean = (v: string) => v.trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();

const SUFFIXES = ['', '_2', '_3', '_4', '_5'];
/** Every env variable that carries a key. Extra keys for one provider: GEMINI_API_KEY_2, GEMINI_API_KEY_3 ... (each gets its own fallback slot). */
export function envStatus(env: NodeJS.ProcessEnv = process.env): { provider: string; var: string | null; extra?: boolean }[] {
  const out: { provider: string; var: string | null; extra?: boolean }[] = [];
  for (const [provider, names] of Object.entries(ENV_KEYS)) { const base = names[0]!; for (const suf of SUFFIXES) { const v = suf ? base + suf : names.find((n) => clean(env[n] ?? '')); if (v && clean(env[v] ?? '')) out.push({ provider, var: v, extra: !!suf }); } }
  // any other variable that obviously holds a known key (e.g. GEMINI_KEY, groq_token, MY_KEY=gsk_…) is picked up by its prefix
  for (const [name, val] of Object.entries(env)) { if (!/(KEY|TOKEN|SECRET)/i.test(name) || /^(YT_|STT_|LLM_)/.test(name)) continue; const v = clean(val ?? ''); const prov = v ? providerFromKey(v) : null; if (prov && !out.some((o) => o.var === name || (o.provider === prov && o.var && clean(env[o.var] ?? '') === v))) out.push({ provider: prov, var: name, extra: out.some((o) => o.provider === prov) }); }
  if (clean(env.AI_API_KEY ?? '') && clean(env.AI_API_BASE ?? '')) out.push({ provider: 'custom', var: 'AI_API_KEY' }); // any OpenAI-compatible endpoint: AI_API_KEY + AI_API_BASE (+ optional AI_API_MODEL)
  out.push({ provider: 'ollama', var: env.OLLAMA_BASE_URL ? 'OLLAMA_BASE_URL' : env.OLLAMA === '1' ? 'OLLAMA' : null }); return out;
}

/** Apply keys found in the environment/.env: each is detected, a model chosen, tested for real and saved to the encrypted store. Unchanged keys are skipped unless force. Failing keys never occupy a slot. */
export async function applyEnvKeys(cfg: Config, o: { force?: boolean; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {}): Promise<{ provider: string; var: string; skipped?: boolean; report?: AutoReport }[]> {
  const env = o.env ?? process.env; const out: { provider: string; var: string; skipped?: boolean; report?: AutoReport }[] = [];
  for (const s of envStatus(env)) {
    if (!s.var) continue;
    if (s.provider === 'custom') { const base = clean(env.AI_API_BASE!).replace(/\/+$/, ''); out.push({ provider: 'custom', var: s.var, report: await autoSetup(cfg, { apiKey: clean(env.AI_API_KEY!), baseUrl: base, provider: 'custom', slot: slotFor(cfg, base, clean(env.AI_API_KEY!)) }, o.fetchFn) }); continue; }
    const c = CATALOG.find((x) => x.id === s.provider)!;
    if (s.provider === 'ollama') { const base = (env.OLLAMA_BASE_URL ? clean(env.OLLAMA_BASE_URL).replace(/\/+$/, '').replace(/(?<!\/v1)$/, '/v1') : c.base); out.push({ provider: 'ollama', var: s.var, report: await autoSetup(cfg, { provider: 'ollama', baseUrl: base, slot: slotFor(cfg, base) }, o.fetchFn) }); continue; }
    const key = clean(env[s.var]!); const n = SLOT_LIST.find((i) => { const x = llmSlot(cfg, i); return x?.baseUrl === c.base && x.apiKey === key; });
    if (!o.force && n) { out.push({ provider: s.provider, var: s.var, skipped: true }); continue; }
    out.push({ provider: s.provider, var: s.var, report: await saveProviderKey(cfg, s.provider, key, o.fetchFn, true) });
  }
  return out;
}
