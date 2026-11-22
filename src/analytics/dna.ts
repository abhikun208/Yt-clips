/**
 * Channel DNA: which content categories a channel actually makes and how each performs (median views, sample size, lift vs the channel's own median),
 * plus a niche-vs-split recommendation. Built only from judged clips with measured views (learn.ts collectObservations). Heuristic, never a promise.
 */
import type { Store } from '../db.ts';
import { collectObservations, MIN_TOTAL, MIN_BUCKET, type Obs } from './learn.ts';
export interface CategoryDna { category: string; n: number; share: number; medianViews: number; lift: number; confidence: 'low' | 'medium' | 'high' }
export interface ChannelDna { channelId: number | null; observations: number; categories: CategoryDna[]; recommendation: 'NO EVIDENCE YET' | 'FOCUS' | 'KEEP_MIXED' | 'SPLIT_CHANNELS'; focus: string | null; reason: string; label: 'HEURISTIC' }
const median = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
export function channelDna(obs: Obs[], channelId: number | null = null): ChannelDna {
  const own = obs.filter((o) => channelId === null || o.channelId === channelId); const base = { channelId, observations: own.length, label: 'HEURISTIC' as const };
  if (own.length < MIN_TOTAL) return { ...base, categories: [], recommendation: 'NO EVIDENCE YET', focus: null, reason: `need >= ${MIN_TOTAL} judged clips with measured views, have ${own.length}` };
  const overall = median(own.map((o) => o.views)); const g = new Map<string, number[]>(); for (const o of own) g.set(o.category, [...(g.get(o.category) ?? []), o.views]);
  const categories: CategoryDna[] = [...g].map(([category, v]) => ({ category, n: v.length, share: +(v.length / own.length).toFixed(2), medianViews: median(v), lift: overall > 0 ? +(median(v) / overall).toFixed(2) : 0, confidence: (v.length >= 20 ? 'high' : v.length >= 10 ? 'medium' : 'low') as CategoryDna['confidence'] })).sort((a, b) => b.n - a.n);
  const solid = categories.filter((c) => c.n >= MIN_BUCKET); const strong = solid.filter((c) => c.lift >= 1.5).sort((a, b) => b.lift - a.lift); const weak = solid.filter((c) => c.lift <= 0.67);
  if (solid.length < 2) return { ...base, categories, recommendation: 'NO EVIDENCE YET', focus: null, reason: `fewer than 2 categories with >= ${MIN_BUCKET} clips: nothing to compare` };
  if (strong.length >= 1 && weak.length >= 1 && solid.length >= 3) return { ...base, categories, recommendation: 'SPLIT_CHANNELS', focus: null, reason: `very different audiences: ${strong.map((c) => c.category).join(', ')} do well while ${weak.map((c) => c.category).join(', ')} do badly; consider separate channels (hypothesis)` };
  if (strong.length === 1 && strong[0]!.share < 0.6) return { ...base, categories, recommendation: 'FOCUS', focus: strong[0]!.category, reason: `${strong[0]!.category} has ${strong[0]!.lift}x the channel median on n=${strong[0]!.n}; test making more of it (hypothesis, not proof)` };
  return { ...base, categories, recommendation: 'KEEP_MIXED', focus: null, reason: 'no category clearly beats the channel median with enough clips; mixing is not hurting' };
}
export const channelDnaFor = (store: Store, channelId: number | null, now = Date.now()): ChannelDna => channelDna(collectObservations(store, now), channelId);
