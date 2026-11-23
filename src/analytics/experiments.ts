/**
 * Persistent experiments memory: hypothesis, at most 3 changed variables, group, measured results, conclusion + confidence.
 * Observations are plain numbers the owner/analytics supply (e.g. avg_pct_viewed per video). Conclusions are HEURISTIC and say
 * "NO EVIDENCE YET" until both groups have enough samples. Nothing here edits a clip or changes any setting.
 */
import type { Store } from '../db.ts';
import { judgeable, judgeOpts, type StatRow } from './studiocsv.ts';
export const MAX_VARIABLES = 3; export const MIN_PER_GROUP = 5;
export interface Experiment { id: number; hypothesis: string; variables: string[]; grp: string; metric: string; status: 'open' | 'concluded'; control: number[]; test: number[]; conclusion: string | null; confidence: string | null; created_at: string }
interface Row { id: number; hypothesis: string; variables_json: string; grp: string; metric: string; status: 'open' | 'concluded'; control_json: string; test_json: string; conclusion: string | null; confidence: string | null; created_at: string }
const hydrate = (r: Row): Experiment => ({ id: r.id, hypothesis: r.hypothesis, variables: JSON.parse(r.variables_json) as string[], grp: r.grp, metric: r.metric, status: r.status, control: JSON.parse(r.control_json) as number[], test: JSON.parse(r.test_json) as number[], conclusion: r.conclusion, confidence: r.confidence, created_at: r.created_at });
export function createExperiment(store: Store, i: { hypothesis: string; variables: string[]; group?: string; metric?: string }): Experiment {
  const hyp = i.hypothesis?.trim(); if (!hyp) throw new Error('hypothesis required');
  const vars = [...new Set((i.variables ?? []).map((v) => v.trim()).filter(Boolean))]; if (!vars.length) throw new Error('at least one variable required'); if (vars.length > MAX_VARIABLES) throw new Error(`max ${MAX_VARIABLES} variables per experiment (more cannot be told apart)`);
  store.exec(`INSERT INTO experiments(hypothesis, variables_json, grp, metric) VALUES (?,?,?,?)`, hyp, JSON.stringify(vars), (i.group ?? 'general').trim() || 'general', (i.metric ?? 'avg_pct_viewed').trim() || 'avg_pct_viewed');
  return getExperiment(store, store.get<{ id: number }>('SELECT max(id) id FROM experiments')!.id)!;
}
export function getExperiment(store: Store, id: number): Experiment | null { const r = store.get<Row>('SELECT * FROM experiments WHERE id=?', id); return r ? hydrate(r) : null; }
export const listExperiments = (store: Store): Experiment[] => store.all<Row>('SELECT * FROM experiments ORDER BY id DESC LIMIT 200').map(hydrate);
export function addObservation(store: Store, id: number, side: 'control' | 'test', value: number): Experiment {
  if (!Number.isFinite(value)) throw new Error('value must be a number'); const e = getExperiment(store, id); if (!e) throw new Error('unknown experiment');
  const col = side === 'control' ? 'control_json' : 'test_json'; store.exec(`UPDATE experiments SET ${col}=? WHERE id=?`, JSON.stringify([...(side === 'control' ? e.control : e.test), value]), id); return getExperiment(store, id)!;
}
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
export interface Verdict { conclusion: 'NO EVIDENCE YET' | 'SUPPORTED' | 'NOT SUPPORTED' | 'INCONCLUSIVE'; confidence: 'none' | 'low' | 'medium' | 'high'; note: string }
export function conclude(e: Pick<Experiment, 'control' | 'test'>): Verdict {
  const n = Math.min(e.control.length, e.test.length); if (n < MIN_PER_GROUP) return { conclusion: 'NO EVIDENCE YET', confidence: 'none', note: `control ${e.control.length} / test ${e.test.length} observations (need ${MIN_PER_GROUP} each)` };
  const mc = mean(e.control), mt = mean(e.test); const rel = mc === 0 ? 0 : (mt - mc) / Math.abs(mc); const conf = n >= 20 && Math.abs(rel) >= 0.2 ? 'high' : n >= 10 && Math.abs(rel) >= 0.1 ? 'medium' : 'low';
  const sd = (x: number[], m: number) => Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)); const se = Math.sqrt(sd(e.control, mc) ** 2 / e.control.length + sd(e.test, mt) ** 2 / e.test.length);
  const noisy = se > 0 && Math.abs(mt - mc) < 2 * se; // difference within ~2 standard errors: cannot be told from noise
  if (noisy || Math.abs(rel) < 0.05) return { conclusion: 'INCONCLUSIVE', confidence: 'low', note: `test ${mt.toFixed(2)} vs control ${mc.toFixed(2)} (${(rel * 100).toFixed(1)}%): not clearly different from noise` };
  return { conclusion: rel > 0 ? 'SUPPORTED' : 'NOT SUPPORTED', confidence: conf, note: `test ${mt.toFixed(2)} vs control ${mc.toFixed(2)} (${(rel * 100).toFixed(1)}%), n=${e.control.length}/${e.test.length}; HEURISTIC` };
}
export function concludeExperiment(store: Store, id: number): { experiment: Experiment; verdict: Verdict } {
  const e = getExperiment(store, id); if (!e) throw new Error('unknown experiment'); const v = conclude(e);
  if (v.conclusion === 'NO EVIDENCE YET') return { experiment: e, verdict: v }; // stays open; nothing is recorded as a result
  store.exec(`UPDATE experiments SET status='concluded', conclusion=?, confidence=? WHERE id=?`, `${v.conclusion}: ${v.note}`, v.confidence, id); return { experiment: getExperiment(store, id)!, verdict: v };
}

const NUMERIC = /^(views|avg_pct_viewed|viewed_pct|swiped_pct|duration_sec)$/;
/**
 * Take the experiment's metric straight from imported YouTube Studio stats (studio_stats) instead of typing it. Each video is
 * counted at most once per experiment, and only when it is judgeable (old enough + enough views, same rule as the rest of the
 * analytics). Anything else is reported back with its reason and nothing is invented.
 */
export function observeFromStudio(store: Store, id: number, side: 'control' | 'test', remoteIds: string[]): { added: number; skipped: { remote_id: string; reason: string }[]; experiment: Experiment } {
  const e = getExperiment(store, id); if (!e) throw new Error('unknown experiment'); if (!NUMERIC.test(e.metric)) throw new Error(`metric "${e.metric}" is not a Studio column (use views, avg_pct_viewed, viewed_pct, swiped_pct or duration_sec)`);
  const o = judgeOpts(store); const skipped: { remote_id: string; reason: string }[] = []; let added = 0;
  for (const rid of [...new Set(remoteIds.map((x) => String(x).trim()).filter(Boolean))].slice(0, 200)) {
    const k = `exp:obs:${id}:${rid}`; if (store.get('SELECT 1 FROM kv WHERE k=?', k)) { skipped.push({ remote_id: rid, reason: 'ALREADY_COUNTED' }); continue; }
    const r = store.get<StatRow>('SELECT * FROM studio_stats WHERE remote_id=?', rid); if (!r) { skipped.push({ remote_id: rid, reason: 'NOT_IN_STUDIO_IMPORT' }); continue; }
    const j = judgeable(r, o); if (!j.ok) { skipped.push({ remote_id: rid, reason: j.reason }); continue; }
    const v = r[e.metric]; if (typeof v !== 'number' || !Number.isFinite(v)) { skipped.push({ remote_id: rid, reason: 'METRIC_MISSING' }); continue; }
    addObservation(store, id, side, v); store.exec('INSERT INTO kv(k,v) VALUES(?,?)', k, side); added++;
  }
  return { added, skipped, experiment: getExperiment(store, id)! };
}
