import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { createApp } from '../src/server/app.ts';
import { createExperiment, addObservation, concludeExperiment, conclude, MIN_PER_GROUP } from '../src/analytics/experiments.ts';
import { testConfig, tmpDir } from './helpers.ts';

test('create validates hypothesis and max 3 variables; persists across reopen', () => {
  const cfg = testConfig({}); const s = new Store(cfg.dbPath);
  assert.throws(() => createExperiment(s, { hypothesis: '', variables: ['hook'] })); assert.throws(() => createExperiment(s, { hypothesis: 'h', variables: [] }));
  assert.throws(() => createExperiment(s, { hypothesis: 'h', variables: ['a', 'b', 'c', 'd'] }), /max 3/);
  const e = createExperiment(s, { hypothesis: 'question hooks keep viewers', variables: ['hook style'], group: 'gaming' }); assert.equal(e.status, 'open');
  const s2 = new Store(cfg.dbPath); assert.equal(s2.get<{ hypothesis: string }>('SELECT hypothesis FROM experiments WHERE id=?', e.id)!.hypothesis, 'question hooks keep viewers');
});
test('too few observations => NO EVIDENCE YET and stays open (nothing recorded)', () => {
  const s = new Store(testConfig({}).dbPath); const e = createExperiment(s, { hypothesis: 'h', variables: ['v'] });
  for (let i = 0; i < MIN_PER_GROUP - 1; i++) { addObservation(s, e.id, 'control', 50); addObservation(s, e.id, 'test', 70); }
  const r = concludeExperiment(s, e.id); assert.equal(r.verdict.conclusion, 'NO EVIDENCE YET'); assert.equal(r.experiment.status, 'open'); assert.equal(r.experiment.conclusion, null);
  assert.throws(() => addObservation(s, e.id, 'test', Number.NaN));
});
test('clear difference => SUPPORTED with confidence; noise => INCONCLUSIVE; worse => NOT SUPPORTED', () => {
  const ctl = [50, 52, 48, 51, 49, 50, 53, 47, 50, 51]; const up = ctl.map((x) => x * 1.3);
  const v = conclude({ control: ctl, test: up }); assert.equal(v.conclusion, 'SUPPORTED'); assert.equal(v.confidence, 'medium');
  assert.equal(conclude({ control: ctl, test: ctl.map((x, i) => x + (i % 2 ? 3 : -3)) }).conclusion, 'INCONCLUSIVE');
  assert.equal(conclude({ control: up, test: ctl }).conclusion, 'NOT SUPPORTED');
  const s = new Store(testConfig({}).dbPath); const e = createExperiment(s, { hypothesis: 'h', variables: ['v'] }); ctl.forEach((x, i) => { addObservation(s, e.id, 'control', x); addObservation(s, e.id, 'test', up[i]!); });
  const r = concludeExperiment(s, e.id); assert.equal(r.experiment.status, 'concluded'); assert.match(r.experiment.conclusion!, /^SUPPORTED/);
});
test('API (real HTTP): create, observe, conclude, list', async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}` }; const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const bad = await fetch(base + '/api/experiments', { method: 'POST', headers: h, body: JSON.stringify({ hypothesis: 'h', variables: ['a', 'b', 'c', 'd'] }) }); assert.equal(bad.status, 400);
    const e = await (await fetch(base + '/api/experiments', { method: 'POST', headers: h, body: JSON.stringify({ hypothesis: 'h', variables: ['a'] }) })).json() as { id: number };
    const o = await fetch(`${base}/api/experiments/${e.id}/observe`, { method: 'POST', headers: h, body: JSON.stringify({ side: 'test', value: 5 }) }); assert.equal(o.status, 200);
    const c = await (await fetch(`${base}/api/experiments/${e.id}/conclude`, { method: 'POST', headers: h })).json() as { verdict: { conclusion: string } }; assert.equal(c.verdict.conclusion, 'NO EVIDENCE YET');
    const l = await (await fetch(base + '/api/experiments', { headers: h })).json() as { experiments: { id: number; test: number[] }[] }; assert.deepEqual(l.experiments.find((x) => x.id === e.id)!.test, [5]);
  } finally { await app.stop(); }
});

test('observeFromStudio: takes the metric from imported Studio stats, only judgeable videos, each video once, reasons reported, never invented', async () => {
  const { observeFromStudio } = await import('../src/analytics/experiments.ts');
  const s = new Store(testConfig({}).dbPath); const e = createExperiment(s, { hypothesis: 'question hooks keep viewers', variables: ['hook style'], metric: 'avg_pct_viewed' });
  const old = new Date(Date.now() - 10 * 86400_000).toISOString(); const young = new Date(Date.now() - 3600_000).toISOString();
  const ins = (id: string, at: string | null, views: number | null, pct: number | null) => s.exec(`INSERT INTO studio_stats(remote_id, published_at, views, avg_pct_viewed) VALUES (?,?,?,?)`, id, at, views, pct);
  ins('ok1', old, 500, 61.5); ins('ok2', old, 900, 48); ins('young', young, 900, 70); ins('few', old, 5, 70); ins('nopct', old, 500, null); ins('noage', null, 500, 40);
  const r = observeFromStudio(s, e.id, 'test', ['ok1', 'ok2', 'young', 'few', 'nopct', 'noage', 'ghost', 'ok1']);
  assert.equal(r.added, 2); assert.deepEqual(r.experiment.test.sort((a, b) => a - b), [48, 61.5]); assert.deepEqual(r.experiment.control, []);
  const why = Object.fromEntries(r.skipped.map((x) => [x.remote_id, x.reason]));
  assert.deepEqual(why, { young: 'TOO_YOUNG', few: 'TOO_FEW_VIEWS', nopct: 'METRIC_MISSING', noage: 'UNKNOWN_AGE', ghost: 'NOT_IN_STUDIO_IMPORT' }, 'duplicate in the same call is deduped silently');
  assert.equal(observeFromStudio(s, e.id, 'test', ['ok1']).skipped[0]!.reason, 'ALREADY_COUNTED', 'a video is never counted twice');
  const bad = createExperiment(s, { hypothesis: 'h', variables: ['v'], metric: 'ctr_guess' }); assert.throws(() => observeFromStudio(s, bad.id, 'test', ['ok1']), /not a Studio column/);
  assert.equal(concludeExperiment(s, e.id).verdict.conclusion, 'NO EVIDENCE YET', 'still honest: 2 samples is not evidence');
});

test('HTTP: POST /api/experiments/:id/observe-studio validates side and ids', async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}`, 'content-type': 'application/json' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const e = await (await fetch(base + '/api/experiments', { method: 'POST', headers: h, body: JSON.stringify({ hypothesis: 'h', variables: ['v'] }) })).json() as { experiment?: { id: number }; id?: number }; const id = e.experiment?.id ?? e.id!;
    assert.equal((await fetch(`${base}/api/experiments/${id}/observe-studio`, { method: 'POST', headers: h, body: JSON.stringify({ side: 'x', remote_ids: ['a'] }) })).status, 400);
    assert.equal((await fetch(`${base}/api/experiments/${id}/observe-studio`, { method: 'POST', headers: h, body: JSON.stringify({ side: 'test', remote_ids: [] }) })).status, 400);
    const ok = await fetch(`${base}/api/experiments/${id}/observe-studio`, { method: 'POST', headers: h, body: JSON.stringify({ side: 'test', remote_ids: ['nope'] }) }); assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { added: number; skipped: { reason: string }[] }).skipped.map((x) => x.reason), ['NOT_IN_STUDIO_IMPORT']);
  } finally { await app.stop?.(); }
});
