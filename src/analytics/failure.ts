/**
 * Failure analysis for ONE video against its peers (similar age/length/category, from peersOf). Pure.
 * Every finding is HEURISTIC and carries confidence + sample size. With too few peers the honest answer is "NO EVIDENCE YET".
 * Causes are hypotheses to test, not facts: this never claims to know why a video failed.
 */
import type { StatRow } from './studiocsv.ts';
export const MIN_PEERS = 5;
export type Cause = 'weak_hook' | 'weak_retention' | 'low_reach_not_quality';
export interface Finding { cause: Cause; confidence: 'low' | 'medium' | 'high'; evidence: string; metric: string; value: number; peerMedian: number; label: 'HEURISTIC' }
export interface Diagnosis { verdict: 'NO EVIDENCE YET' | 'NO PROBLEM FOUND' | 'FINDINGS'; sample: number; needed: number; findings: Finding[]; note: string }
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const nums = (rows: StatRow[], k: 'views' | 'avg_pct_viewed' | 'viewed_pct' | 'swiped_pct'): number[] => rows.map((r) => r[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
const conf = (n: number, rel: number): Finding['confidence'] => (n >= 20 && rel >= 0.3 ? 'high' : n >= 10 && rel >= 0.2 ? 'medium' : 'low');
export function diagnose(target: StatRow, peers: StatRow[]): Diagnosis {
  const n = peers.length;
  if (n < MIN_PEERS) return { verdict: 'NO EVIDENCE YET', sample: n, needed: MIN_PEERS, findings: [], note: `only ${n} comparable judged videos (need ${MIN_PEERS}); no cause is claimed` };
  const findings: Finding[] = [];
  const add = (cause: Cause, metric: string, value: number, med: number, rel: number, text: string) => findings.push({ cause, confidence: conf(n, rel), evidence: `${text} (this ${value} vs peer median ${+med.toFixed(2)}, n=${n})`, metric, value, peerMedian: +med.toFixed(2), label: 'HEURISTIC' });
  const sw = nums(peers, 'swiped_pct'); if (typeof target.swiped_pct === 'number' && sw.length >= MIN_PEERS) { const m = median(sw); if (m > 0 && target.swiped_pct > m * 1.15) add('weak_hook', 'swiped_pct', target.swiped_pct, m, (target.swiped_pct - m) / m, 'more viewers swiped away than usual: the first seconds may not hold'); }
  const ret = nums(peers, 'avg_pct_viewed'); if (typeof target.avg_pct_viewed === 'number' && ret.length >= MIN_PEERS) { const m = median(ret); if (m > 0 && target.avg_pct_viewed < m * 0.85) add('weak_retention', 'avg_pct_viewed', target.avg_pct_viewed, m, (m - target.avg_pct_viewed) / m, 'people leave earlier than on comparable videos'); }
  const v = nums(peers, 'views'); if (typeof target.views === 'number' && v.length >= MIN_PEERS && !findings.length) { const m = median(v); if (m > 0 && target.views < m * 0.6) add('low_reach_not_quality', 'views', target.views, m, (m - target.views) / m, 'views are low but hook/retention are not worse than peers: topic or timing may be the issue (cannot be checked here)'); }
  return { verdict: findings.length ? 'FINDINGS' : 'NO PROBLEM FOUND', sample: n, needed: MIN_PEERS, findings, note: findings.length ? 'hypotheses to test with the next clip (see experiments), not proven causes' : 'no metric is clearly worse than comparable videos' };
}
