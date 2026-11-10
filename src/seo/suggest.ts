import type { Store } from '../db.ts';

/**
 * Real "what people search" phrases: YouTube's own search-box autocomplete (the public suggest endpoint, no key).
 * Best effort: any failure (offline, blocked, rate-limited) returns [] and the engine uses the clip's own keywords.
 * Cached 24 h in the kv table so a clip batch makes at most one request per keyword.
 */
/** Keep only Roman-script suggestions that contain the keyword as a WHOLE word: a mis-heard word ("chin") must not drag in "chinese drama" or Devanagari names. */
export const relevantSuggestions = (items: string[], keyword: string): string[] => { const k = keyword.trim().toLowerCase(); if (!k) return []; const re = new RegExp(`(^|[^\\p{L}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u'); return items.filter((x) => !/[^\u0000-\u024F\u2000-\u206F\u{1F300}-\u{1FAFF}]/u.test(x) && re.test(x.toLowerCase())); };
export async function suggestKeywords(store: Store | null, q: string, o: { hl?: string; fetchFn?: typeof fetch; max?: number } = {}): Promise<string[]> {
  const query = q.trim().slice(0, 60); if (query.length < 3) return [];
  const key = `suggest:${o.hl ?? 'hi'}:${query.toLowerCase()}`;
  try { const c = store?.get<{ v: string }>('SELECT v FROM kv WHERE k=?', key)?.v; if (c) { const j = JSON.parse(c) as { at: number; items: string[] }; if (Date.now() - j.at < 86_400_000) return j.items; } } catch { /* no cache */ }
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=${encodeURIComponent(o.hl ?? 'hi')}&q=${encodeURIComponent(query)}`;
    const res = await (o.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(4000) }); if (!res.ok) return [];
    const j = JSON.parse(await res.text()) as [string, string[]]; const items = (Array.isArray(j[1]) ? j[1] : []).filter((x) => typeof x === 'string' && x.toLowerCase() !== query.toLowerCase()).map((x) => x.trim()).filter((x) => x.length >= 3 && x.length <= 60).slice(0, o.max ?? 6);
    try { store?.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, key, JSON.stringify({ at: Date.now(), items })); } catch { /* cache is optional */ }
    return items;
  } catch { return []; }
}
