/**
 * LLM provider health registry + smart ordering (the "AI orchestrator" the owner asked for, without any browser tricks):
 *  - every call outcome is recorded per provider key (url|model|key tail): ok / rate-limit (429) / auth (401,403) / down (5xx, timeout, network);
 *  - a rate-limited provider is put in COOL-DOWN (Retry-After when given, else 2 min, doubling up to 15 min) and is NOT hammered; down = 1 min doubling to 10 min;
 *    rejected key = 1 h doubling to 6 h; one success clears the penalty;
 *  - `orderChain` puts healthy providers first (the owner's slot order is kept unless a provider's recent success ratio is clearly worse), cooling ones LAST (still tried
 *    when everything else failed, so a wrong guess never leaves the system with no provider);
 *  - `allProvidersDown` lets the sentinel alert the owner only when NO provider can answer.
 */
export interface LlmEnvLike { baseUrl: string; apiKey?: string; model: string }
type Outcome = 'ok' | 'rate' | 'auth' | 'down';
interface St { until: number; strikes: number; ok: number; fail: number; last?: Outcome; lastAt: number }
const S = new Map<string, St>();
export const providerKey = (e: LlmEnvLike): string => `${e.baseUrl.replace(/\/+$/, '')}|${e.model}|${(e.apiKey ?? '').slice(-6)}`;
const st = (e: LlmEnvLike): St => { const k = providerKey(e); let s = S.get(k); if (!s) { s = { until: 0, strikes: 0, ok: 0, fail: 0, lastAt: 0 }; S.set(k, s); } return s; };
export const resetLlmHealth = (): void => S.clear();

export function reportLlm(e: LlmEnvLike, outcome: Outcome, o: { retryAfterSec?: number; now?: number } = {}): void {
  const s = st(e); const now = o.now ?? Date.now(); s.last = outcome; s.lastAt = now;
  if (outcome === 'ok') { s.ok++; s.strikes = 0; s.until = 0; return; }
  s.fail++; s.strikes++; const x = 2 ** Math.min(s.strikes - 1, 6);
  const ms = outcome === 'rate' ? Math.min(15 * 60_000, o.retryAfterSec && o.retryAfterSec > 0 ? o.retryAfterSec * 1000 : 120_000 * x) : outcome === 'down' ? Math.min(10 * 60_000, 60_000 * x) : Math.min(6 * 3600_000, 3600_000 * x);
  s.until = Math.max(s.until, now + ms);
}
export const outcomeOfStatus = (status: number): Outcome => (status >= 200 && status < 300 ? 'ok' : status === 429 ? 'rate' : status === 401 || status === 403 ? 'auth' : 'down');
/** fetch wrapper that records the outcome; the caller still gets the Response (or the network error) exactly as before. */
export async function llmFetch(f: typeof fetch, e: LlmEnvLike, url: string, init: RequestInit): Promise<Response> {
  try {
    const r = await f(url, init); const oc = outcomeOfStatus(r.status);
    if (oc === 'ok' || r.status < 500 && r.status !== 429 && r.status !== 401 && r.status !== 403) { if (oc === 'ok') reportLlm(e, 'ok'); } // 400/404 = our request, not the provider's health
    else reportLlm(e, oc, { retryAfterSec: Number(r.headers.get('retry-after')) || undefined });
    return r;
  } catch (err) { reportLlm(e, 'down'); throw err; }
}
export function orderChain<T extends LlmEnvLike>(chain: T[], now = Date.now()): T[] {
  const ratio = (e: T) => { const s = S.get(providerKey(e)); const n = s ? s.ok + s.fail : 0; return n >= 3 ? s!.ok / n : 1; };
  const idx = new Map(chain.map((e, i) => [e, i] as const)); const ok = chain.filter((e) => (S.get(providerKey(e))?.until ?? 0) <= now); const cool = chain.filter((e) => !ok.includes(e));
  // keep the owner's order, but a provider that fails more than half of its recent calls drops behind the reliable ones
  ok.sort((a, b) => (ratio(a) < 0.5 ? 1 : 0) - (ratio(b) < 0.5 ? 1 : 0) || idx.get(a)! - idx.get(b)!);
  cool.sort((a, b) => (S.get(providerKey(a))!.until) - (S.get(providerKey(b))!.until));
  return [...ok, ...cool];
}
export const allProvidersDown = (chain: LlmEnvLike[], now = Date.now()): boolean => chain.length > 0 && chain.every((e) => (S.get(providerKey(e))?.until ?? 0) > now);
export const llmHealth = (chain: LlmEnvLike[], now = Date.now()) => chain.map((e) => { const s = S.get(providerKey(e)); return { provider: e.baseUrl.replace(/^https?:\/\//, '').split('/')[0], model: e.model, state: !s || s.until <= now ? 'healthy' : s.last === 'auth' ? 'key-rejected' : s.last === 'rate' ? 'rate-limited' : 'down', retryInSec: s && s.until > now ? Math.round((s.until - now) / 1000) : 0, ok: s?.ok ?? 0, fail: s?.fail ?? 0 }; });
