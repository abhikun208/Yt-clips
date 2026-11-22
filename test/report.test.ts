import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { buildReport } from '../src/analytics/report.ts';
import { createApp } from '../src/server/app.ts';
import { testConfig, tmpDir } from './helpers.ts';

test('empty data => NO EVIDENCE YET, no invented findings, says it is rule based', () => {
  const r = buildReport(new Store(testConfig({}).dbPath)); assert.equal(r.status, 'NO EVIDENCE YET'); assert.equal(r.confidence, 'none'); assert.deepEqual(r.working, []); assert.deepEqual(r.notWorking, []); assert.equal(r.generatedBy, 'rules (no AI model)'); assert.ok(r.nextExperiments.length);
});
test('API + dashboard (real HTTP): report endpoint answers and UI contains the card wired to it', async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}` }; const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const r = await (await fetch(base + '/api/analytics/report', { headers: h })).json() as { status: string; openExperiments: number }; assert.equal(r.status, 'NO EVIDENCE YET'); assert.equal(r.openExperiments, 0);
    const html = await (await fetch(base + '/', { headers: h })).text(); assert.match(html, /id="rep"/); assert.match(html, /\/api\/analytics\/report/);
  } finally { await app.stop(); }
});
test('with enough measured clips the report names a strength, a weakness, hypotheses and a next experiment (data seeded in the real tables)', () => {
  const s = new Store(testConfig({}).dbPath); s.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`);
  const plan: [string, number][] = [...Array.from({ length: 6 }, (): [string, number] => ['gaming', 5000]), ...Array.from({ length: 6 }, (): [string, number] => ['vlog', 1000]), ...Array.from({ length: 6 }, (): [string, number] => ['comedy', 200])];
  plan.forEach(([cat, views], i) => { const n = i + 1;
    s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint, category) VALUES (?,1,0,30,.5,?,?)`, n, `c${n}`, cat); s.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (?,?,?,?,1)`, n, n, `o${n}`, '/tmp/x.mp4');
    s.exec(`INSERT INTO uploads(clip_id, platform, state, remote_id, idempotency_key) VALUES (?, 'youtube_shorts', 'PUBLISHED', ?, ?)`, n, `r${n}`, `k${n}`);
    s.exec(`INSERT INTO analytics_snapshots(platform, remote_id, views, published_at) VALUES ('youtube_shorts', ?, ?, ?)`, `r${n}`, views, '2026-01-01T00:00:00Z'); });
  const r = buildReport(s); assert.equal(r.status, 'OK'); assert.equal(r.observations, 18);
  assert.ok(r.working.some((w) => /gaming/.test(w)), 'gaming is a strength'); assert.ok(r.notWorking.some((w) => /comedy/.test(w)), 'comedy is a weakness');
  assert.ok(r.reasons.length > 0 && r.nextExperiments.some((x) => /gaming/.test(x))); assert.equal(r.confidence, 'low'); assert.match(r.note, /not proven/);
});
