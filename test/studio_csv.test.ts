import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { createApp } from '../src/server/app.ts';
import { importStudioCsv, parseDuration, judgeable, judgeOpts, peersOf, categoryOf } from '../src/analytics/studiocsv.ts';
import { tmpDir } from './helpers.ts';

const NOW = Date.parse('2026-11-20T00:00:00Z'); const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const CSV = `Content,Video title,Video publish time,Duration,Views,Engaged views,Average view duration,Average percentage viewed (%),Watch time (hours),Likes,Comments,Shares,Subscribers,Impressions,Viewed vs swiped away (%),Extra col
Total,,,,"12,345",,,,,,,,,,,x
vid_a,"Clutch, 1v4",${iso(10)},0:21,"1,200",900,0:15,71.4%,5.0,80,3,4,2,9000,64.5,y
vid_b,Funny fail,${iso(9)},0:24,350,,0:10,41.6,1.0,10,0,0,0,,,
vid_c,Fresh one,${iso(1)},0:20,5000,,0:12,60,16.6,100,9,8,1,,,
vid_d,Low views,${iso(12)},0:55,20,,0:08,30,0.1,1,0,0,0,,,
,,,,,,,,,,,,,,,
,No views,${iso(5)},0:20,,,,,,,,,,,,
`;
function seed() { const s = new Store(':memory:'); return s; }

test('Studio CSV: parses quoted cells / thousands / mm:ss / percent, skips Total + bad rows, keeps missing cells NULL, labels MANUAL_IMPORT', () => {
  const s = seed(); const r = importStudioCsv(s, CSV); assert.equal(r.imported, 4); assert.equal(r.source, 'MANUAL_IMPORT'); assert.deepEqual(r.unmappedColumns, ['Extra col']);
  assert.deepEqual(r.skipped.map((x) => x.reason), ['Total row', 'bad views']);
  const a = s.get<Record<string, unknown>>('SELECT * FROM studio_stats WHERE remote_id=?', 'vid_a')!; assert.equal(a.title, 'Clutch, 1v4'); assert.equal(a.views, 1200); assert.equal(a.avg_view_duration_sec, 15); assert.equal(a.avg_pct_viewed, 71.4); assert.equal(a.viewed_pct, 64.5); assert.equal(a.swiped_pct, null, 'not provided -> NULL, never derived');
  const b = s.get<Record<string, unknown>>('SELECT * FROM studio_stats WHERE remote_id=?', 'vid_b')!; assert.equal(b.engaged_views, null); assert.equal(b.impressions, null); assert.equal(b.source, 'MANUAL_IMPORT');
  assert.equal(parseDuration('1:02:03'), 3723); assert.equal(parseDuration('45'), 45); assert.equal(parseDuration('x'), null);
});
test('Studio CSV: re-import updates the same video (idempotent); invalid files are rejected with a clear error', () => {
  const s = seed(); importStudioCsv(s, CSV); importStudioCsv(s, CSV.replace('"1,200"', '1500')); assert.equal(s.get<{ n: number }>('SELECT COUNT(*) n FROM studio_stats')!.n, 4); assert.equal(s.get<{ views: number }>('SELECT views FROM studio_stats WHERE remote_id=?', 'vid_a')!.views, 1500);
  assert.throws(() => importStudioCsv(s, 'a,b\n1,2'), /Content|Video title/); assert.throws(() => importStudioCsv(s, 'Content,Likes\nx,1'), /Views/);
});
test('judging rule: not before 72 h, not below the minimum views, unknown age is never judged; thresholds are owner-configurable', () => {
  const o = { minAgeHours: 72, minViews: 100, now: NOW };
  assert.deepEqual(judgeable({ published_at: iso(1), views: 5000 }, o).reason, 'TOO_YOUNG'); assert.equal(judgeable({ published_at: iso(10), views: 20 }, o).reason, 'TOO_FEW_VIEWS');
  assert.equal(judgeable({ published_at: null, views: 5000 }, o).reason, 'UNKNOWN_AGE'); assert.equal(judgeable({ published_at: iso(10), views: 1200 }, o).ok, true); assert.equal(judgeable({ published_at: new Date(NOW - 72 * 3_600_000).toISOString(), views: 100 }, o).ok, true, 'exactly 72 h / 100 views qualifies');
  const s = seed(); assert.deepEqual([judgeOpts(s).minAgeHours, judgeOpts(s).minViews], [72, 100]); s.exec(`INSERT INTO kv(k, v) VALUES ('analytics:minViews','500'),('analytics:minAgeHours','24')`); assert.deepEqual([judgeOpts(s).minAgeHours, judgeOpts(s).minViews], [24, 500]);
});
test('peers: only judgeable videos of similar age, similar length and the same category; reasons for exclusions are counted', () => {
  const s = seed(); importStudioCsv(s, CSV);
  // vid_a (clutch, gaming) vs: vid_b (similar age/len, comedy category) -> category excluded; vid_c too young; vid_d different length + too few views
  s.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`);
  for (const [i, cat, rid] of [[1, 'gaming', 'vid_a'], [2, 'comedy', 'vid_b'], [3, 'gaming', 'vid_e']] as const) { s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint, category) VALUES (?,1,0,10,.5,?,?)`, i, `c${i}`, cat); s.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (?,?,?,?,1)`, i, i, `o${i}`, '/tmp/x.mp4'); s.exec(`INSERT INTO uploads(clip_id, platform, state, remote_id, idempotency_key) VALUES (?, 'youtube_shorts', 'PUBLISHED', ?, ?)`, i, rid, `k${i}`); }
  assert.equal(categoryOf(s, 'vid_a'), 'gaming');
  s.exec(`INSERT INTO studio_stats(remote_id, title, published_at, duration_sec, views) VALUES ('vid_e','Another clutch',?,22,800)`, iso(11));
  const r = peersOf(s, 'vid_a', { now: NOW }); assert.deepEqual(r.peers.map((p) => p.remote_id), ['vid_e']); assert.equal(r.excluded.different_category, 1); assert.ok((r.excluded.not_judgeable ?? 0) >= 1, 'young / low-view videos are excluded');
  assert.equal(peersOf(s, 'nope').target, null);
});
test('API: POST /api/analytics/studio-import then GET /api/analytics/studio shows the judging verdict per row (real HTTP)', async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}` }; const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const r = await fetch(base + '/api/analytics/studio-import', { method: 'POST', headers: h, body: CSV }); assert.equal(r.status, 200); assert.equal(((await r.json()) as { imported: number }).imported, 4);
    const g = await (await fetch(base + '/api/analytics/studio', { headers: h })).json() as { source: string; rule: { minAgeHours: number }; rows: { remote_id: string; judge: { reason: string } }[] };
    assert.equal(g.source, 'MANUAL_IMPORT'); assert.equal(g.rule.minAgeHours, 72); assert.equal(g.rows.length, 4);
    const reason = (id: string) => g.rows.find((x) => x.remote_id === id)!.judge.reason; assert.notEqual(reason('vid_a'), 'UNKNOWN_AGE');
    const bad = await fetch(base + '/api/analytics/studio-import', { method: 'POST', headers: h, body: 'x,y\n1,2' }); assert.ok(bad.status >= 400 && bad.status < 500, `invalid CSV -> ${bad.status}`);
  } finally { await app.stop(); }
});
