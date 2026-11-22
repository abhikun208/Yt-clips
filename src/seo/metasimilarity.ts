/**
 * Cross-video metadata similarity: catches near-duplicate titles ("Insane clutch 1v4 #Shorts" vs "INSANE clutch 1v4!!"), numbered templates
 * ("Best play 3" / "Best play 7") and copy-pasted descriptions, which the exact-match check in clipmeta.ts misses. Pure.
 * Series parts of the SAME series are expected to look alike and are excluded by the caller.
 */
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'and', 'is', 'ka', 'ki', 'ke', 'ye', 'ek', 'hai', 'shorts', 'short', 'part']);
export const titleKey = (t: string): string[] => t.toLowerCase().replace(/#\S+/g, ' ').replace(/[0-9]+/g, '#').replace(/[^\p{L}\p{N}#\s]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
const jaccard = (a: Iterable<string>, b: Iterable<string>): number => { const x = new Set(a), y = new Set(b); if (!x.size || !y.size) return 0; let i = 0; for (const v of x) if (y.has(v)) i++; return i / (x.size + y.size - i); };
const shingles = (t: string, n = 3): string[] => { const w = t.toLowerCase().replace(/https?:\S+|#\S+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean); const out: string[] = []; for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' ')); return out.length ? out : w; };
export const titleSimilarity = (a: string, b: string): number => jaccard(titleKey(a), titleKey(b));
export const descriptionSimilarity = (a: string, b: string): number => jaccard(shingles(a), shingles(b));

export interface Other { id: number; title: string; description: string }
export interface MetaCheck { titleMax: number; titleWith: number | null; descMax: number; descWith: number | null; flags: ('near_duplicate_title' | 'similar_title' | 'similar_description')[] }
/** thresholds: title >= 0.8 near duplicate, >= 0.6 similar; description >= 0.7 similar. Numbers are normalised, so "Best play 3" vs "Best play 7" counts as the same template. */
export function checkMetadata(md: { title: string; description: string }, others: Other[]): MetaCheck {
  let tMax = 0, tWith: number | null = null, dMax = 0, dWith: number | null = null;
  for (const o of others) { const t = titleSimilarity(md.title, o.title); if (t > tMax) { tMax = t; tWith = o.id; } const d = descriptionSimilarity(md.description, o.description); if (d > dMax) { dMax = d; dWith = o.id; } }
  const flags: MetaCheck['flags'] = []; if (tMax >= 0.8) flags.push('near_duplicate_title'); else if (tMax >= 0.6) flags.push('similar_title'); if (dMax >= 0.7) flags.push('similar_description');
  return { titleMax: +tMax.toFixed(2), titleWith: tWith, descMax: +dMax.toFixed(2), descWith: dWith, flags };
}
/** Picks the alternative title least similar to every earlier title; null when no alternative is clearly better than the current one. */
export function lessSimilarTitle(current: string, alternatives: string[], others: Other[]): string | null {
  const score = (t: string) => Math.max(0, ...others.map((o) => titleSimilarity(t, o.title))); const cur = score(current);
  const best = alternatives.map((t) => ({ t, s: score(t) })).filter((x) => x.s < 0.6 && x.s < cur).sort((a, b) => a.s - b.s)[0];
  return best?.t ?? null;
}
