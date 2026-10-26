import type { Config } from '../config.ts';
import { readFileSync } from 'node:fs';
import { PRESETS, saveAi, isLocalBase, llmSlot, SLOT_LIST } from './settings.ts';

export interface CatalogEntry { id: string; label: string; base: string; keyHint: string; getKey: string; models: string[]; stt: string[] }
export const CATALOG: CatalogEntry[] = (JSON.parse(readFileSync(new URL('./providers.json', import.meta.url), 'utf8')) as { providers: CatalogEntry[] }).providers;

/**
 * "Give only the API key": figure out the provider (key prefix, else probe each provider's GET /models), list the models that key can use,
 * rank them (free/cheap chat models first), then PROVE the pick with a real 1-token chat call before saving. Falls through to the next
 * candidate if a call fails. Base URLs/model families come from each provider's docs (read 2026-10-25); the live model list always wins
 * over any hard-coded name because providers rename models often.
 */
export interface Model { id: string; free?: boolean }
export const NOT_CHAT = /whisper|embed|tts|orpheus|guard|safeguard|imagen|image|veo|video|moderation|audio|transcri|rerank|aqa|speech|live|robotics|computer-use|dall|search-preview/i;
const ver = (id: string) => (id.match(/(\d+(?:\.\d+)?)/g) ?? []).map(Number);
const cmpVerDesc = (a: string, b: string) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] ?? 0) - (x[i] ?? 0); if (d) return d; } return 0; };
const sizeB = (id: string) => { const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(id) ?? /-(\d+)b/i.exec(id); return m ? Number(m[1]) : 0; };

export type ProviderId = 'groq' | 'gemini' | 'openrouter' | 'xai' | 'mistral' | 'ollama' | 'lmstudio';
export const KEY_PREFIX: Record<string, ProviderId> = { gsk_: 'groq', AIza: 'gemini', 'AQ.': 'gemini', 'sk-or-': 'openrouter', 'xai-': 'xai' };
export const PROBE_ORDER: ProviderId[] = ['groq', 'gemini', 'openrouter', 'xai', 'mistral'];
export const providerFromBase = (base: string): string | null => { for (const [id, b] of Object.entries(BASES)) if (base.replace(/\/+$/, '') === b) return id; return /11434/.test(base) ? 'ollama' : null; };
export const providerFromKey = (key: string): ProviderId | null => { for (const [p, id] of Object.entries(KEY_PREFIX)) if (key.startsWith(p)) return id; return null; };

/** Best-first chat models for a provider (pure; unit-tested). */
export function rankChat(provider: string, models: Model[]): string[] {
  const chat = models.filter((m) => !NOT_CHAT.test(m.id));
  const first = (re: RegExp) => chat.filter((m) => re.test(m.id));
  const uniq = (xs: string[]) => [...new Set(xs)];
  switch (provider) {
    case 'groq': return uniq([...first(/^llama-3\.3-70b-versatile$/), ...first(/gpt-oss-120b/), ...first(/gpt-oss-20b/), ...first(/llama-3\.1-8b-instant/), ...chat.map((m) => m.id).sort(cmpVerDesc)].map((x) => typeof x === 'string' ? x : (x as Model).id));
    case 'gemini': { const ids = chat.map((m) => m.id).filter((id) => /^gemini/.test(id)); const flash = ids.filter((id) => /flash/.test(id) && !/lite/.test(id) && !/preview|exp/.test(id)).sort(cmpVerDesc), lite = ids.filter((id) => /flash-lite/.test(id)).sort(cmpVerDesc), rest = ids.filter((id) => /flash/.test(id)).sort(cmpVerDesc); return uniq([...flash, ...lite, ...rest, ...ids.sort(cmpVerDesc)]); }
    case 'openrouter': { // concrete, well-known free models first (obscure free models are often rate-limited upstream); router id last
      const PRIO = [/llama-3\.3-70b/, /gpt-oss-120b/, /gpt-oss-20b/, /qwen3?.*(235|80|72|32)b/i, /gemma-3-27b/, /deepseek.*(chat|v3|r1)/i, /mistral.*(small|24b)/i, /llama-3\.[12]/, /gemma|qwen|mistral|llama|deepseek/i];
      const rank = (id: string) => { const i = PRIO.findIndex((r) => r.test(id)); return i < 0 ? 99 : i; };
      const free = chat.filter((m) => (m.free || /:free$/.test(m.id)) && m.id !== 'openrouter/free').map((m) => m.id).sort((a, b) => rank(a) - rank(b) || cmpVerDesc(a, b));
      return uniq([...free, ...chat.filter((m) => m.id === 'openrouter/free').map((m) => m.id)]); }
    case 'xai': { const ids = chat.map((m) => m.id).filter((id) => /^grok/.test(id)); return uniq([...ids.filter((id) => /mini/.test(id)).sort(cmpVerDesc), ...ids.sort(cmpVerDesc)]); }
    case 'mistral': { const ids = chat.map((m) => m.id); return uniq([...ids.filter((id) => /small-latest/.test(id)), ...ids.filter((id) => /latest/.test(id)), ...ids]); }
    default: { // ollama / lmstudio / anything local: what is installed. Prefer common instruct families, 3-14B first (fast on a laptop), then the rest.
      const ids = chat.map((m) => m.id); const fam = ids.filter((id) => /llama|qwen|gemma|mistral|phi|deepseek|gpt-oss/i.test(id)); const ok = fam.filter((id) => { const b = sizeB(id); return b === 0 || (b >= 3 && b <= 14); });
      return uniq([...ok.sort((a, b) => (sizeB(a) || 8) - (sizeB(b) || 8)), ...fam, ...ids]);
    }
  }
}
export const rankStt = (models: Model[]): string[] => { const w = models.map((m) => m.id).filter((id) => /whisper/i.test(id)); return [...w.filter((x) => /turbo/.test(x)), ...w.filter((x) => !/turbo/.test(x))]; };

const T = (ms: number) => AbortSignal.timeout(ms);
export async function fetchModels(base: string, key: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; status: number; models: Model[]; message?: string }> {
  try {
    const r = await fetchFn(`${base.replace(/\/+$/, '')}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: T(20_000) }); if (!r.ok) { const e = await r.json().catch(() => null) as { error?: { message?: string } | string; message?: string } | { error?: { message?: string } }[] | null; const em = Array.isArray(e) ? e[0]?.error?.message : typeof e?.error === 'string' ? e.error : e?.error?.message ?? e?.message; return { ok: false, status: r.status, models: [], message: String(em ?? '').slice(0, 160) }; }
    const j = await r.json() as { data?: { id?: string; pricing?: { prompt?: string | number; completion?: string | number } }[]; models?: { name?: string }[] };
    const a = (j.data ?? []).map((x) => ({ id: String(x.id ?? '').replace(/^models\//, ''), free: x.pricing ? Number(x.pricing.prompt) === 0 && Number(x.pricing.completion) === 0 : undefined }));
    const b = (j.models ?? []).map((x) => ({ id: String(x.name ?? '').replace(/^models\//, '') }));
    return { ok: true, status: 200, models: [...a, ...b].filter((m) => m.id) };
  } catch { return { ok: false, status: 0, models: [] }; }
}
async function chatOk(base: string, key: string, model: string, fetchFn: typeof fetch): Promise<{ ok: boolean; status: number; msg: string }> {
  try {
    const r = await fetchFn(`${base.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with: ok' }] }), signal: T(45_000) });
    const j = await r.json().catch(() => null) as { choices?: unknown[]; error?: { message?: string } } | null;
    const em = String(j?.error?.message ?? (Array.isArray(j) ? (j as { error?: { message?: string } }[])[0]?.error?.message : '') ?? ''); return { ok: r.ok && !!j?.choices?.length, status: r.status, msg: em.slice(0, 120) };
  } catch (e) { return { ok: false, status: 0, msg: String((e as Error).message).slice(0, 100) }; }
}

export interface AutoReport { ok: boolean; provider: string | null; base: string | null; steps: { ok: boolean; text: string }[]; llm?: { model: string; slot: number }; stt?: { model: string } }
const BASES: Record<string, string> = Object.fromEntries(PRESETS.map((p) => [p.id, p.base]));

export async function autoSetup(cfg: Config, o: { apiKey?: string; provider?: string; baseUrl?: string; slot?: number }, fetchFn: typeof fetch = fetch): Promise<AutoReport> {
  const rep: AutoReport = { ok: false, provider: null, base: null, steps: [] }; const say = (ok: boolean, text: string) => rep.steps.push({ ok, text });
  const key = (o.apiKey ?? '').trim(); const slot = o.slot ?? 1;
  let provider: string | null = o.provider && o.provider !== 'auto' ? o.provider : null; let base = (o.baseUrl ?? '').trim().replace(/\/+$/, '') || (provider ? BASES[provider] ?? '' : '');
  let models: Model[] = [];
  if (!provider && !base) {
    const guess = providerFromKey(key);
    if (guess) { provider = guess; base = BASES[guess]!; say(true, `Key ka prefix ${guess} jaisa hai`); }
  }
  if (!base) { // unknown key shape: probe the known providers; first one that accepts the key wins
    if (!key) { say(false, 'API key daalo (ya local Ollama ke liye provider = ollama chuno)'); return rep; }
    for (const p of PROBE_ORDER) { const m = await fetchModels(BASES[p]!, key, fetchFn); if (m.ok) { provider = p; base = BASES[p]!; models = m.models; say(true, `${p} ne key accept ki`); break; } else say(false, `${p}: HTTP ${m.status || 'no connection'}${m.message ? ' ' + m.message : ''}`); }
    if (!base) { say(false, 'Kisi bhi provider ne key accept nahi ki. Key sahi copy hui? Ya provider/base URL manually chuno.'); return rep; }
  }
  provider ??= providerFromBase(base); rep.provider = provider ?? 'custom'; rep.base = base;
  if (!key && !isLocalBase(base)) { say(false, 'Is provider ke liye API key chahiye'); return rep; }
  if (!models.length) {
    const m = await fetchModels(base, key, fetchFn);
    if (!m.ok) { say(false, m.status === 401 || m.status === 403 ? `Key reject hui (HTTP ${m.status}${m.message ? ': ' + m.message : ''}) — provider khud is key ko galat bol raha hai. Naya key banao (${(CATALOG.find((c) => c.id === provider)?.getKey) ?? 'provider dashboard'}), poora copy karo; shell mein purani ${String(provider ?? '').toUpperCase()}_API_KEY set ho to \`unset\` karo` : m.status === 400 && provider === 'gemini' ? 'Gemini galat key par HTTP 400 deta hai: key dobara copy karo (aistudio.google.com/apikey se, shuru "AIza")' : m.status === 404 ? `Base URL galat lagta hai (${base}/models → 404)` : m.status === 0 ? `Server tak pahunch nahi paya (${base})${isLocalBase(base) ? ' — Ollama chal raha hai? "ollama serve"' : ''}` : `HTTP ${m.status}${m.message ? ': ' + m.message : ''}`); return rep; }
    models = m.models;
  }
  say(true, `${models.length} models mile`); if (!models.length) { say(false, provider === 'ollama' ? 'Ollama mein koi model installed nahi: pehle `ollama pull llama3.2` chalao' : 'Is key par koi model nahi mila'); return rep; }
  const cat = CATALOG.find((c) => c.id === provider); const live = new Set(models.map((m) => m.id));
  const ranked = [...new Set([...(cat?.models ?? []).filter((m) => live.has(m) && m !== 'openrouter/free'), ...rankChat(provider ?? 'custom', models), ...(live.has('openrouter/free') ? ['openrouter/free'] : [])])]; if (!ranked.length) { say(false, 'Koi chat model nahi mila'); return rep; }
  const queue = ranked.slice(0, provider === 'openrouter' ? 8 : 5); let policyFails = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi]!;
    const t = await chatOk(base, key, id, fetchFn);
    if (t.ok || t.status === 429 || t.status >= 500 || /rate.?limit|overload|high demand|try again/i.test(t.msg)) { say(true, `${id} ${t.ok ? 'ne jawab diya' : 'sahi hai (provider abhi busy/rate-limit, HTTP ' + t.status + ')'}`); saveAi(cfg, 'llm', { apiKey: key || undefined, baseUrl: base, model: id, slot }); rep.llm = { model: id, slot }; rep.ok = true; break; }
    say(false, `${id}: HTTP ${t.status || 'x'} ${t.msg}`.trim());
    const hint = /(?:use|try|update[^.]*to use)\s+models\/([\w.\-]+)/i.exec(t.msg)?.[1]; if (hint && !queue.includes(hint) && queue.length < 10) queue.splice(qi + 1, 0, hint); // provider told us the replacement model
    if (provider === 'openrouter' && /0 endpoints|data policy|privacy|guardrail/i.test(t.msg) && ++policyFails >= 3) { say(false, 'OpenRouter: aapke account ki privacy/guardrail setting free models ko block kar rahi hai. openrouter.ai/settings/privacy mein free endpoints allow karo (ya account par kuch credit rakho). Tab tak Gemini/Groq use karo.'); break; }
  }
  if (!rep.ok) say(false, 'Top models ne jawab nahi diya. Models list se manually chuno ("Models dikhao").');
  const stt = rankStt(models)[0]; if (stt && key) { try { saveAi(cfg, 'stt', { apiKey: key, baseUrl: base, model: stt }); rep.stt = { model: stt }; say(true, `Speech-to-text bhi set: ${stt} (Test dabake pakka karo)`); } catch { /* optional */ } }
  return rep;
}

/** "Auto fix" for a failing connection: reuse the key/base already saved in that slot, re-detect a working model. */
export async function autoFix(cfg: Config, target: string, fetchFn: typeof fetch = fetch): Promise<AutoReport> {
  const [kind, arg] = target.split(':'); const { llmSlot, sttCreds } = await import('./settings.ts');
  if (kind === 'llm') { const c = llmSlot(cfg, Number(arg ?? 1)); if (!c) return { ok: false, provider: null, base: null, steps: [{ ok: false, text: 'Is slot mein key save nahi hai: upar Auto setup mein key daalo' }] }; return autoSetup(cfg, { apiKey: c.apiKey, baseUrl: c.baseUrl, slot: Number(arg ?? 1) }, fetchFn); }
  if (kind === 'stt') {
    const c = sttCreds(cfg); const rep: AutoReport = { ok: false, provider: null, base: c?.baseUrl ?? null, steps: [] };
    if (!c) { rep.steps.push({ ok: false, text: 'Speech-to-text API save nahi hai. API zaruri nahi: Setup → Local speech-to-text se local engine chalao' }); return rep; }
    const host = (() => { try { return new URL(c.baseUrl).host; } catch { return c.baseUrl; } })(); const m = await fetchModels(c.baseUrl, c.apiKey, fetchFn);
    if (!m.ok) { rep.steps.push({ ok: false, text: m.status === 0 ? `${host} tak pahunch nahi paya (base URL galat ya offline). Groq ke liye: ${BASES.groq}. Ya "Sirf local" speech-to-text use karo` : `${host}: HTTP ${m.status} (key/URL check karo)` }); return rep; }
    const w = rankStt(m.models)[0]; if (!w) { rep.steps.push({ ok: false, text: `${host} par koi whisper model nahi hai. Groq key daalo ya local speech-to-text use karo` }); return rep; }
    saveAi(cfg, 'stt', { apiKey: c.apiKey, baseUrl: c.baseUrl, model: w }); rep.ok = true; rep.stt = { model: w }; rep.provider = providerFromBase(c.baseUrl); rep.steps.push({ ok: true, text: `${host}: model ${w} set` }); return rep;
  }
  return { ok: false, provider: null, base: null, steps: [{ ok: false, text: 'is target ke liye auto fix nahi' }] };
}

/** Simple path used by the UI: provider + key only. Picks/reuses a slot (existing slot for this provider, else the first empty, else slot 3). */
export function slotFor(cfg: Config, base: string, key?: string): number {
  const b = base.replace(/\/+$/, '');
  if (key) { for (const n of SLOT_LIST) { const c = llmSlot(cfg, n); if (c?.baseUrl === b && c.apiKey === key) return n; } for (const n of SLOT_LIST) if (!llmSlot(cfg, n)) return n; return SLOT_LIST[SLOT_LIST.length - 1]!; } // extra key for the same provider (e.g. Gemini key 2): own slot
  for (const n of SLOT_LIST) if (llmSlot(cfg, n)?.baseUrl === b) return n;
  for (const n of SLOT_LIST) if (!llmSlot(cfg, n)) return n; return SLOT_LIST[SLOT_LIST.length - 1]!;
}
export async function saveProviderKey(cfg: Config, id: string, apiKey: string, fetchFn: typeof fetch = fetch, extra = false): Promise<AutoReport> {
  const c = CATALOG.find((x) => x.id === id); if (!c) return { ok: false, provider: null, base: null, steps: [{ ok: false, text: 'unknown provider' }] };
  return autoSetup(cfg, { apiKey, provider: id, baseUrl: c.base, slot: slotFor(cfg, c.base, extra ? apiKey : undefined) }, fetchFn);
}

/** Safe key-shape report for debugging "key reject": never prints the key (only length, first 4 chars, and suspicious characters). */
export function keyShape(raw: string): { length: number; start: string; problems: string[] } {
  const problems: string[] = []; if (/^["']|["']$/.test(raw)) problems.push('quotes ke saath'); if (/\s/.test(raw.trim())) problems.push('beech mein space/newline'); if (raw !== raw.trim()) problems.push('aage/peeche space'); if (/[^\x21-\x7e]/.test(raw.trim())) problems.push('non-ASCII character (copy ke saath kuch extra aa gaya)'); if (/^bearer/i.test(raw)) problems.push('"Bearer" likha hai'); if (/#/.test(raw)) problems.push('# hai (comment samjha ja sakta hai)');
  return { length: raw.trim().length, start: raw.trim().slice(0, 4), problems };
}
