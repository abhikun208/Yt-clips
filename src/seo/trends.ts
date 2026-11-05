import type { Store } from '../db.ts';

/**
 * Trend hints for titles, WITHOUT any API key: public news RSS feeds (default: Google News India, English + Hindi; override with YT_CLIPS_TRENDS_FEEDS = comma-separated URLs).
 * A trend is only handed to the title writer when it really appears in THIS video's own words - a trending name that the video never mentions would make the
 * title misleading (YouTube treats that as spam/misleading metadata and it kills retention), so unrelated trends are dropped.
 */
export const DEFAULT_FEEDS = ['https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en', 'https://news.google.com/rss?hl=hi&gl=IN&ceid=IN:hi'];
const STOP = new Set('with from this that have about after their there which would could today news live latest says said will what when where over into more than they them been being your india indian video watch full'.split(' '));
const dec = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;|&gt;/g, ' ').trim();

export function parseRssTitles(xml: string, max = 40): string[] {
  const out: string[] = []; for (const m of xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)) { const t = dec(m[1]!).replace(/\s+-\s+[^-]{2,40}$/, ''); if (t.length >= 8) out.push(t); if (out.length >= max) break; }
  return out;
}
export async function fetchTrends(store: Store, o: { fetchFn?: typeof fetch; now?: number; feeds?: string[] } = {}): Promise<string[]> {
  const now = o.now ?? Date.now(); const cached = store.get<{ v: string }>(`SELECT v FROM kv WHERE k='trends:cache'`)?.v;
  if (cached) { try { const c = JSON.parse(cached) as { at: number; titles: string[] }; if (now - c.at < 6 * 3600_000) return c.titles; } catch { /* refetch */ } }
  const f = o.fetchFn ?? fetch; const feeds = o.feeds ?? (process.env.YT_CLIPS_TRENDS_FEEDS ? process.env.YT_CLIPS_TRENDS_FEEDS.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_FEEDS); const titles: string[] = [];
  for (const u of feeds) { try { const r = await f(u, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; yt-clips)' } }); if (r.ok) titles.push(...parseRssTitles(await r.text())); } catch { /* a dead feed never blocks metadata */ } }
  if (titles.length) store.exec(`INSERT INTO kv(k,v) VALUES('trends:cache', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, JSON.stringify({ at: now, titles }));
  else if (cached) { try { return (JSON.parse(cached) as { titles: string[] }).titles; } catch { /* none */ } }
  return titles;
}
const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
/** Trending phrases (<= max) that are genuinely present in the video: two consecutive significant headline words both spoken in the clip, or a capitalised name spoken in it. */
export function relevantTrends(transcript: string, headlines: string[], max = 3): string[] {
  const spoken = new Set(words(transcript)); const out: string[] = [];
  for (const h of headlines) {
    const toks = h.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i]!, lw = w.toLowerCase(); if (lw.length < 4 || STOP.has(lw) || !spoken.has(lw)) continue;
      const nx = toks[i + 1]; const bigram = nx && nx.length >= 4 && !STOP.has(nx.toLowerCase()) && spoken.has(nx.toLowerCase());
      const name = /^\p{Lu}/u.test(w) && i > 0; // capitalised and not just the sentence start
      if (bigram) { out.push(`${w} ${nx}`); break; } if (name) { out.push(w); break; }
    }
    if (out.length >= max) break;
  }
  return [...new Set(out)].slice(0, max);
}
