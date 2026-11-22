import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, MIN_PEERS } from '../src/analytics/failure.ts';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';
import type { StatRow } from '../src/analytics/studiocsv.ts';

const row = (o: Partial<StatRow>): StatRow => ({ remote_id: 'x', title: null, published_at: null, duration_sec: 30, views: 1000, avg_pct_viewed: 80, viewed_pct: 70, swiped_pct: 30, ...o });
const peers = (n: number): StatRow[] => Array.from({ length: n }, (_, i) => row({ remote_id: 'p' + i }));

test('too few peers => NO EVIDENCE YET, no cause claimed', () => {
  const d = diagnose(row({ swiped_pct: 90 }), peers(MIN_PEERS - 1)); assert.equal(d.verdict, 'NO EVIDENCE YET'); assert.deepEqual(d.findings, []); assert.equal(d.sample, MIN_PEERS - 1);
});
test('swipe-away well above peers => weak_hook finding with sample size and HEURISTIC label', () => {
  const d = diagnose(row({ swiped_pct: 50 }), peers(12)); assert.equal(d.verdict, 'FINDINGS'); const f = d.findings[0]!; assert.equal(f.cause, 'weak_hook'); assert.equal(f.label, 'HEURISTIC'); assert.match(f.evidence, /n=12/); assert.equal(f.confidence, 'medium');
});
test('confidence grows with sample size; few peers stays low', () => {
  assert.equal(diagnose(row({ avg_pct_viewed: 50 }), peers(6)).findings[0]!.confidence, 'low'); assert.equal(diagnose(row({ avg_pct_viewed: 50 }), peers(25)).findings[0]!.confidence, 'high');
});
test('low views with fine quality => low_reach_not_quality; normal video => NO PROBLEM FOUND', () => {
  assert.equal(diagnose(row({ views: 300 }), peers(8)).findings[0]!.cause, 'low_reach_not_quality');
  assert.equal(diagnose(row({}), peers(8)).verdict, 'NO PROBLEM FOUND');
});
test('API: GET /api/analytics/failure (real HTTP): few peers => NO EVIDENCE YET, young video => not judgeable, unknown => 404', async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}` }; const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  const iso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const csv = `Content,Video title,Video publish time,Duration,Views,Average percentage viewed (%),Viewed vs swiped away (%)\nv1,A,${iso(10)},0:21,1200,70,60\nv2,B,${iso(9)},0:22,900,65,55\nv3,C,${iso(1)},0:20,5000,60,50\n`;
  try {
    assert.equal((await fetch(base + '/api/analytics/studio-import', { method: 'POST', headers: h, body: csv })).status, 200);
    const a = await (await fetch(base + '/api/analytics/failure?remote_id=v1', { headers: h })).json() as { diagnosis: { verdict: string; sample: number } }; assert.equal(a.diagnosis.verdict, 'NO EVIDENCE YET'); assert.equal(a.diagnosis.sample, 1);
    const y = await (await fetch(base + '/api/analytics/failure?remote_id=v3', { headers: h })).json() as { judge: { reason: string }; diagnosis: { verdict: string } }; assert.equal(y.judge.reason, 'TOO_YOUNG'); assert.equal(y.diagnosis.verdict, 'NO EVIDENCE YET');
    assert.equal((await fetch(base + '/api/analytics/failure?remote_id=zzz', { headers: h })).status, 404);
  } finally { await app.stop(); }
});
