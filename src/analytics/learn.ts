import type { Store } from '../db.ts';
import { getChannel, updateChannel, type ChannelConfig } from '../channels.ts';
import { info } from '../util/log.ts';

/**
 * Bounded, evidence-based learning loop (Prompt1 §17). It only READS measured metrics and only ever proposes / applies changes to
 * FUTURE clip selection (the channel's preferred clip-length bucket). It never touches editing presets, captions, fonts, render or
 * encoding settings, never edits an already published clip, and every change is versioned and reversible.
 *  - missing metrics are "unavailable" (excluded), never counted as 0
 *  - a clip is judged only after `minAgeHours` (default 48 h)
 *  - small samples are not interpreted: >= MIN_TOTAL observations and >= MIN_BUCKET per group, otherwise "insufficient_evidence"
 *  - an insight states its evidence and confidence; a cause is only ever labelled a hypothesis
 *  - a proposal changes nothing until applyChange(); evaluateChange() only RECOMMENDS keep/revert from later results
 */
export const MIN_TOTAL = 12; export const MIN_BUCKET = 4; export const MIN_AGE_HOURS = 48;

export interface Obs { uploadId: number; clipId: number; platform: string; channelId: number | null; category: string; durationSec: number; views: number; publishedAt: string; ageHours: number }
export interface Insight { dimension: 'duration' | 'category'; bucket: string; n: number; medianViews: number; overallMedian: number; lift: number; kind: 'strength' | 'weakness'; confidence: 'low' | 'medium' | 'high'; hypothesis: string }
export interface Analysis { observations: number; status: 'ok' | 'insufficient_evidence'; reason?: string; overallMedian: number | null; insights: Insight[] }
export type LengthBucket = 'u30' | '30-60' | '60-90' | '90-180';
export interface Change { id: number; version: number; kind: 'clip_length'; channelId: number; from: string | null; to: LengthBucket; status: 'proposed' | 'applied' | 'reverted'; evidence: { bucket: string; n: number; lift: number; confidence: string }; baseline: { median: number; n: number }; createdAt: string; appliedAt?: string; revertedAt?: string; verdict?: { keep: boolean; reason: string; medianAfter: number; n: number; at: string } }

const kvGet = (s: Store, k: string): string | null => s.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v ?? null;
const kvSet = (s: Store, k: string, v: string): void => { s.exec('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v); };
const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const durBucket = (d: number): string => (d < 30 ? 'under30' : d < 60 ? '30-60' : d < 90 ? '60-90' : '90plus');
const BUCKET_TO_LENGTH: Record<string, LengthBucket> = { under30: 'u30', '30-60': '30-60', '60-90': '60-90', '90plus': '90-180' };

/** One observation per published upload with a measured view count, old enough to judge. */
export function collectObservations(store: Store, now = Date.now(), minAgeHours = MIN_AGE_HOURS): Obs[] {
  const rows = store.all<{ id: number; clip_id: number; platform: string; channel_id: number | null; remote_id: string; category: string | null; start_sec: number; end_sec: number; views: number | null; pub: string | null; upd: string }>(
    `SELECT u.id, u.clip_id, u.platform, u.channel_id, u.remote_id, k.category, k.start_sec, k.end_sec, s.views, s.published_at AS pub, u.updated_at AS upd
     FROM uploads u JOIN clips c ON c.id=u.clip_id JOIN candidates k ON k.id=c.candidate_id
     JOIN analytics_snapshots s ON s.id=(SELECT MAX(id) FROM analytics_snapshots WHERE platform=u.platform AND remote_id=u.remote_id)
     WHERE u.remote_id IS NOT NULL AND u.state IN ('PUBLISHED','ANALYTICS_WAIT','ANALYZING','LEARNING','NEXT_CYCLE')`);
  const out: Obs[] = [];
  for (const r of rows) {
    if (r.views == null || !Number.isFinite(r.views)) continue; // unavailable != 0
    const at = r.pub ?? r.upd; const t = Date.parse(at.includes('T') ? at : at.replace(' ', 'T') + 'Z'); if (!Number.isFinite(t)) continue;
    const age = (now - t) / 3_600_000; if (age < minAgeHours) continue; // too early to judge
    out.push({ uploadId: r.id, clipId: r.clip_id, platform: r.platform, channelId: r.channel_id, category: r.category ?? 'unknown', durationSec: r.end_sec - r.start_sec, views: r.views, publishedAt: at, ageHours: Math.round(age) });
  }
  return out;
}

const conf = (n: number): Insight['confidence'] => (n >= 20 ? 'high' : n >= 10 ? 'medium' : 'low');

export function analyze(obs: Obs[]): Analysis {
  if (obs.length < MIN_TOTAL) return { observations: obs.length, status: 'insufficient_evidence', reason: `need >= ${MIN_TOTAL} judged clips with measured views, have ${obs.length}`, overallMedian: obs.length ? median(obs.map((o) => o.views)) : null, insights: [] };
  const overall = median(obs.map((o) => o.views)); const insights: Insight[] = [];
  const dims: [Insight['dimension'], (o: Obs) => string][] = [['duration', (o) => durBucket(o.durationSec)], ['category', (o) => o.category]];
  for (const [dimension, key] of dims) {
    const g = new Map<string, number[]>(); for (const o of obs) g.set(key(o), [...(g.get(key(o)) ?? []), o.views]);
    if (g.size < 2) continue; // nothing to compare against
    for (const [bucket, v] of g) {
      if (v.length < MIN_BUCKET) continue; const m = median(v); const lift = overall > 0 ? m / overall : 0;
      if (lift >= 1.5 || lift <= 0.67) insights.push({ dimension, bucket, n: v.length, medianViews: m, overallMedian: overall, lift: Math.round(lift * 100) / 100, kind: lift >= 1.5 ? 'strength' : 'weakness', confidence: conf(v.length), hypothesis: `HYPOTHESIS (not proven): ${dimension} "${bucket}" clips ${lift >= 1.5 ? 'outperform' : 'underperform'} the median; other factors (topic, posting time, hook, audience) may explain it` });
    }
  }
  return { observations: obs.length, status: 'ok', overallMedian: overall, insights: insights.sort((a, b) => Math.abs(Math.log(b.lift)) - Math.abs(Math.log(a.lift))) };
}

const changes = (s: Store): Change[] => s.all<{ k: string; v: string }>(`SELECT k, v FROM kv WHERE k LIKE 'learn:change:%'`).map((r) => JSON.parse(r.v) as Change).sort((a, b) => a.id - b.id);
export const listChanges = changes;
const save = (s: Store, c: Change): void => kvSet(s, `learn:change:${c.id}`, JSON.stringify(c));

/** Propose (never apply) at most one bounded change per channel: switch the preferred clip-length bucket to a clearly stronger one. */
export function proposeChanges(store: Store, now = Date.now()): Change[] {
  const obs = collectObservations(store, now); const made: Change[] = [];
  const byCh = new Map<number, Obs[]>(); for (const o of obs) if (o.channelId != null) byCh.set(o.channelId, [...(byCh.get(o.channelId) ?? []), o]);
  for (const [channelId, list] of byCh) {
    const a = analyze(list); if (a.status !== 'ok') continue;
    const best = a.insights.find((i) => i.dimension === 'duration' && i.kind === 'strength' && i.confidence !== 'low'); if (!best) continue;
    const to = BUCKET_TO_LENGTH[best.bucket]; if (!to) continue;
    const cur = getChannel(store, channelId).config.clipLength ?? null; if (cur === to) continue;
    if (changes(store).some((c) => c.channelId === channelId && (c.status === 'proposed' || (c.status === 'applied' && !c.verdict)))) continue; // one open change at a time -> results stay attributable
    const id = Number(kvGet(store, 'learn:seq') ?? 0) + 1; kvSet(store, 'learn:seq', String(id));
    const c: Change = { id, version: id, kind: 'clip_length', channelId, from: cur, to, status: 'proposed', evidence: { bucket: best.bucket, n: best.n, lift: best.lift, confidence: best.confidence }, baseline: { median: a.overallMedian ?? 0, n: list.length }, createdAt: new Date(now).toISOString() };
    save(store, c); made.push(c);
  }
  return made;
}

/** Explicit, reversible: only changes the channel's preferred clip-length for FUTURE analysis. */
export function applyChange(store: Store, id: number, now = Date.now()): Change {
  const c = changes(store).find((x) => x.id === id); if (!c) throw new Error(`learning change ${id} not found`); if (c.status !== 'proposed') throw new Error(`change ${id} is ${c.status}, not proposed`);
  const ch = getChannel(store, c.channelId); const cfg: ChannelConfig = { ...ch.config, clipLength: c.to };
  updateChannel(store, ch.id, { config: cfg }, () => true);
  const done: Change = { ...c, status: 'applied', appliedAt: new Date(now).toISOString() }; save(store, done); info('learning change applied', { id, channel: ch.slug, clipLength: c.to }); return done;
}
export function revertChange(store: Store, id: number, now = Date.now()): Change {
  const c = changes(store).find((x) => x.id === id); if (!c) throw new Error(`learning change ${id} not found`); if (c.status !== 'applied') throw new Error(`change ${id} is ${c.status}, not applied`);
  const ch = getChannel(store, c.channelId); const cfg: ChannelConfig = { ...ch.config }; if (c.from) cfg.clipLength = c.from as LengthBucket; else delete cfg.clipLength;
  store.exec('UPDATE channels SET config_json=? WHERE id=?', JSON.stringify(cfg), ch.id); // updateChannel merges (cannot drop a key); this restores the exact previous config
  const done: Change = { ...c, status: 'reverted', revertedAt: new Date(now).toISOString() }; save(store, done); info('learning change reverted', { id, channel: ch.slug }); return done;
}

/** Compare clips PUBLISHED after the change was applied with the baseline. Only a recommendation (never acts); needs MIN_BUCKET judged clips. */
export function evaluateChange(store: Store, id: number, now = Date.now()): Change {
  const c = changes(store).find((x) => x.id === id); if (!c) throw new Error(`learning change ${id} not found`); if (c.status !== 'applied' || !c.appliedAt) throw new Error(`change ${id} is not applied`);
  const after = collectObservations(store, now).filter((o) => o.channelId === c.channelId && Date.parse(o.publishedAt.includes('T') ? o.publishedAt : o.publishedAt.replace(' ', 'T') + 'Z') >= Date.parse(c.appliedAt!));
  if (after.length < MIN_BUCKET) return c; // not enough new evidence yet: no verdict (never judged early)
  const m = median(after.map((o) => o.views)); const keep = m >= c.baseline.median * 0.9;
  const done: Change = { ...c, verdict: { keep, reason: keep ? 'results since the change are not worse than the baseline median' : 'results since the change are clearly below the baseline median; consider reverting (small sample, may be unrelated)', medianAfter: m, n: after.length, at: new Date(now).toISOString() } };
  save(store, done); return done;
}

export function learningReport(store: Store, now = Date.now()): { analysis: Analysis; changes: Change[] } { return { analysis: analyze(collectObservations(store, now)), changes: changes(store) }; }
