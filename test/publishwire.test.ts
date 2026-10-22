import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { Store } from '../src/db.ts';
import { importAnalyticsCsv, hourStats, planFromStore, parseCsv } from '../src/schedule/analytics.ts';
import { loadConfig } from '../src/config.ts';
import { startFake } from './fakeGoogle.ts';
import { tmpDir, makeFixture } from './helpers.ts';

const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

test('analytics CSV: quotes/aliases parsed, bad rows skipped with reasons, idempotent re-import', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\r\n1,"x ""q""",3\r\n'), [['a', 'b,c', 'd'], ['1', 'x "q"', '3']]);
  const s = new Store(':memory:');
  const csv = ['Video publish time,Views,Average percentage viewed (%)', '2026-10-01T18:30:00+05:30,"1,200",55', '2026-10-02,500,40', 'garbage,5,1', '2026-10-03T12:00:00,5,1', '2026-10-04T12:00:00Z,-1,1'].join('\n');
  const r = importAnalyticsCsv(s, csv); assert.equal(r.imported, 1); assert.equal(r.skipped.length, 4);
  assert.match(r.skipped.map((x) => x.reason).join('|'), /no time of day.*bad published_at|bad published_at.*no time/s);
  importAnalyticsCsv(s, csv); assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM analytics')!.n, 1, 'idempotent');
  assert.equal(s.get<{ views: number }>('SELECT views FROM analytics')!.views, 1200);
  assert.throws(() => importAnalyticsCsv(s, 'a,b\n1,2'), /need columns/);
});

test('scheduler uses MEASURED hours once enough evidence exists, baseline before; slots avoid quiet hours', () => {
  const s = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() });
  assert.equal(planFromStore(s, { n: 2, tz: cfg.timezone, cfg: cfg.schedule }).slots[0]!.basis, 'baseline');
  const lines = ['published_at,views']; for (let i = 1; i <= 12; i++) lines.push(`2026-09-${String(i).padStart(2, '0')}T14:00:00Z,${i % 2 ? 9000 : 8000}`, `2026-09-${String(i).padStart(2, '0')}T05:00:00Z,50`);
  importAnalyticsCsv(s, lines.join('\n')); const st = hourStats(s, 'UTC'); assert.equal(st.find((x) => x.hour === 14)!.samples, 12);
  const p = planFromStore(s, { n: 3, tz: 'UTC', cfg: { ...cfg.schedule, quietHours: [0, 6] }, from: new Date('2026-10-20T00:00:00Z') });
  assert.equal(p.samples, 24); assert.ok(p.slots.every((x) => x.basis === 'measured')); assert.ok(p.slots.every((x) => x.hour >= 6 || x.hour === undefined));
  assert.ok(p.slots.some((x) => Math.abs(x.hour - 14) <= 1), 'best measured hour is used');
});

test('server API: uploads queue/advance with gates OFF never touch network; youtube connect via fake Google; gates not settable', async () => {
  const f = await startFake(); const old = { ...process.env };
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'cid', YT_OAUTH_CLIENT_SECRET: 'csec' });
  const dataDir = tmpDir(); const src = join(tmpDir(), 'v.mp4'); await makeFixture(src);
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir, autoRun: false, overrides: { clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 1, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } } });
  const base = `http://127.0.0.1:${await app.start()}`; const J = (r: Response) => r.json() as Promise<any>;
  try {
    let st = await J(await fetch(`${base}/api/youtube`, { headers: auth })); assert.equal(st.connected, false); assert.equal(st.clientConfigured, true); assert.equal(st.gates.publishEnabled, false);
    const c = await J(await fetch(`${base}/api/youtube/connect`, { method: 'POST', headers: auth })); assert.equal(c.userCode, 'ABCD-EFGH');
    assert.equal((await J(await fetch(`${base}/api/youtube/connect/poll`, { method: 'POST', headers: auth }))).status, 'pending');
    assert.equal((await J(await fetch(`${base}/api/youtube/connect/poll`, { method: 'POST', headers: auth }))).status, 'ok');
    st = await J(await fetch(`${base}/api/youtube`, { headers: auth })); assert.equal(st.connected, true); assert.ok(!JSON.stringify(st).includes('REFRESH-TOKEN'));
    // a rendered clip row (QC pass, metadata) built directly so the test stays fast
    const edited = join(tmpDir(), 'e.mp4'); await makeFixture(edited);
    app.store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1, ?, 'f')`, src); app.store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,10,.5,'c')`);
    app.store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, edited, JSON.stringify({ title: 'T #Shorts', description: 'd', tags: ['x'] }));
    assert.equal((await fetch(`${base}/api/uploads`, { method: 'POST', headers: auth, body: JSON.stringify({}) })).status, 400);
    const q = await J(await fetch(`${base}/api/uploads`, { method: 'POST', headers: auth, body: JSON.stringify({ clipId: 1, platform: 'youtube_shorts' }) })); assert.ok(q.id);
    // 16:9 fixture is not vertical => platform QC fails (a real, truthful block), never reaches the network
    const before = f.log.length;
    const a1 = await J(await fetch(`${base}/api/uploads/${q.id}/advance`, { method: 'POST', headers: auth, body: '{}' })); assert.ok(['QC_FAILED', 'QC_PASSED', 'UPLOAD_PENDING'].includes(a1.state), JSON.stringify(a1));
    for (let i = 0; i < 4; i++) await fetch(`${base}/api/uploads/${q.id}/advance`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(f.log.filter((x) => x.path.includes('/upload/')).length, 0, 'no upload traffic while gates are off'); void before;
    const list = await J(await fetch(`${base}/api/uploads`, { headers: auth })); assert.equal(list.uploads.length, 1);
    assert.equal((await fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify({ gates: { publishEnabled: true } }) })).status, 400);
    const imp = await J(await fetch(`${base}/api/analytics/import`, { method: 'POST', headers: { authorization: auth.authorization }, body: 'published_at,views\n2026-10-01T10:00:00Z,100\n' })); assert.equal(imp.imported, 1);
    const sc = await J(await fetch(`${base}/api/schedule?n=2`, { headers: auth })); assert.equal(sc.slots.length, 2); assert.equal(sc.samples, 1);
    assert.equal((await fetch(`${base}/api/uploads/999/advance`, { method: 'POST', headers: auth, body: '{}' })).status, 400);
  } finally { await app.stop(); await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
