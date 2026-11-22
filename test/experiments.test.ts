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
