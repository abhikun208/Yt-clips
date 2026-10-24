import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { collectRetention, learnedCategoryPrior } from '../src/publish/service.ts';
import { titleTestTick, funnelTick, pickWinner, listTitleTests } from '../src/publish/titletest.ts';
import { YT_FORCE_SSL_SCOPE, YT_ANALYTICS_SCOPE } from '../src/publish/oauth.ts';
import { tmpDir } from './helpers.ts';

/** Minimal YouTube-shaped endpoint (offline stand-in; the owner's real run is `test:real` / `smoke`). */
async function stub() {
  const st = { title: 'Title A', views: 100, privacy: 'public', log: [] as string[], comments: [] as unknown[], reports: [] as string[] };
  const srv = createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const u = new URL(req.url!, 'http://x'); const body = Buffer.concat(chunks).toString(); st.log.push(`${req.method} ${u.pathname}`); const send = (c: number, j: unknown) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/token') return send(200, { access_token: 'at', expires_in: 3600 });
    if (u.pathname === '/v2/reports') { st.reports.push(u.search); return send(200, { columnHeaders: [{ name: 'views' }, { name: 'averageViewPercentage' }, { name: 'averageViewDuration' }, { name: 'estimatedMinutesWatched' }, { name: 'subscribersGained' }], rows: [[500, 71.5, 18.2, 150, 4]] }); }
    if (u.pathname === '/youtube/v3/videos' && req.method === 'GET') return send(200, { items: [{ id: 'V1', snippet: { title: st.title, description: 'desc', tags: ['a'], categoryId: '20' }, status: { privacyStatus: st.privacy }, statistics: { viewCount: String(st.views) } }] });
    if (u.pathname === '/youtube/v3/videos' && req.method === 'PUT') { const j = JSON.parse(body); assert.equal(j.snippet.description, 'desc', 'description re-sent so it is not wiped'); assert.equal(j.snippet.categoryId, '20'); st.title = j.snippet.title; return send(200, { id: 'V1' }); }
    if (u.pathname === '/youtube/v3/commentThreads') { st.comments.push(JSON.parse(body)); return send(200, { id: 'C1' }); }
    send(404, {}); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); return { st, base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() };
}
function seed(store: Store, n: number, category: string, remote: string, chId: number, titles = ['Title A', 'Title B', 'Title C']) {
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (?,?,?)`, n, `/x${n}`, `f${n}`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint, category) VALUES (?,?,0,6,.5,?,?)`, n, n, `c${n}`, category);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,1,?)`, n, n, `o${n}`, '/tmp/x.mp4', JSON.stringify({ title: titles[0], titles }));
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, remote_id, channel_id) VALUES (?,?,?,?,?,?)`, n, 'youtube_shorts', 'PUBLISHED', `k${n}`, remote, chId);
}

test('retention: reads averageViewPercentage etc. via analytics API, needs the analytics scope, feeds a learned category prior', async () => {
  const s = await stub(); const old = { ...process.env }; Object.assign(process.env, { YT_API_BASE: s.base, YT_ANALYTICS_BASE: s.base, YT_OAUTH_BASE: s.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir: dir }); const store = new Store(':memory:'); const sec = SecretStore.forData(dir);
    seed(store, 1, 'funny', 'V1', 1);
    sec.write('youtube', { refresh_token: 'R', scope: YT_FORCE_SSL_SCOPE }); const none = await collectRetention(store, cfg); assert.equal(none.recorded, 0); assert.match(none.skipped[0]!, /no analytics scope/);
    sec.write('youtube', { refresh_token: 'R', scope: `${YT_FORCE_SSL_SCOPE} ${YT_ANALYTICS_SCOPE}` }); const ok = await collectRetention(store, cfg); assert.equal(ok.recorded, 1, JSON.stringify(ok));
    assert.deepEqual({ ...(store.get('SELECT views, avg_view_pct, avg_view_sec, subs_gained FROM retention') as object) }, { views: 500, avg_view_pct: 71.5, avg_view_sec: 18.2, subs_gained: 4 }); assert.ok(s.st.reports[0]!.includes('filters=video%3D%3DV1') && s.st.reports[0]!.includes('channel%3D%3DMINE'));
    assert.deepEqual(learnedCategoryPrior(store, 1), {}, 'too few videos => no prior');
    // 6 more videos: funny holds viewers better than gaming
    for (let i = 2; i <= 7; i++) { seed(store, i, i % 2 ? 'funny' : 'dull', `W${i}`, 1); store.exec('INSERT INTO retention(platform, remote_id, channel_id, avg_view_pct) VALUES (?,?,?,?)', 'youtube_shorts', `W${i}`, 1, i % 2 ? 80 : 30); }
    const pr = learnedCategoryPrior(store, 1); assert.ok(pr.funny! > 1 && pr.dull! < 1 && pr.funny! <= 1.15 && pr.dull! >= 0.9, JSON.stringify(pr));
  } finally { s.close(); process.env = old; }
});

test('title A/B: rotates variants per window, keeps title unless a later one wins by 20%, gated, never wipes the description', async () => {
  assert.deepEqual(pickWinner([{ title: 'A', views: 100, hours: 24, vph: 4 }, { title: 'B', views: 110, hours: 24, vph: 4.6 }, { title: 'C', views: 90, hours: 24, vph: 3.7 }]).title, 'A', 'B is only 15% better: decay bias, keep A');
  assert.equal(pickWinner([{ title: 'A', views: 100, hours: 24, vph: 4 }, { title: 'B', views: 130, hours: 24, vph: 5.4 }]).title, 'B');
  const s = await stub(); const old = { ...process.env }; Object.assign(process.env, { YT_API_BASE: s.base, YT_OAUTH_BASE: s.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dir = tmpDir(); SecretStore.forData(dir).write('youtube', { refresh_token: 'R' }); const store = new Store(':memory:'); seed(store, 1, 'funny', 'V1', 1);
    const mk = (o: Record<string, unknown>) => loadConfig(process.cwd(), { dataDir: dir, overrides: o });
    const t0 = new Date('2026-11-01T00:00:00Z'); const h = (n: number) => new Date(t0.getTime() + n * 3600_000);
    assert.equal((await titleTestTick(store, mk({}), t0)).started, 0, 'off by default'); assert.equal(s.st.log.length, 0);
    assert.equal((await titleTestTick(store, mk({ automation: { titleTest: true } }), t0)).started, 0, 'public gate closed => nothing'); assert.equal(s.st.log.length, 0);
    const cfg = mk({ automation: { titleTest: true, titleTestHours: 24 }, gates: { publishEnabled: true, publicVisibilityAllowed: true } });
    assert.equal((await titleTestTick(store, cfg, t0)).started, 1);
    s.st.views = 148; let r = await titleTestTick(store, cfg, h(10)); assert.equal(r.switched, 0, 'window not over');
    r = await titleTestTick(store, cfg, h(24)); assert.equal(r.switched, 1); assert.equal(s.st.title, 'Title B');
    s.st.views = 148 + 200; r = await titleTestTick(store, cfg, h(48)); assert.equal(r.switched, 1); assert.equal(s.st.title, 'Title C');
    s.st.views = 348 + 30; r = await titleTestTick(store, cfg, h(72)); assert.equal(r.finished, 1);
    const t = listTitleTests(store)[0]!; assert.equal(t.state, 'done'); assert.equal(t.winner, 'Title B', 'B had 200 views/24h vs 48 and 30'); assert.equal(s.st.title, 'Title B'); assert.equal(t.results.length, 3);
  } finally { s.close(); process.env = old; }
});

test('funnel comment: only with the comment gate + liveUrl + scope, once per video, tells owner pinning is manual', async () => {
  const s = await stub(); const old = { ...process.env }; Object.assign(process.env, { YT_API_BASE: s.base, YT_OAUTH_BASE: s.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dir = tmpDir(); const sec = SecretStore.forData(dir); sec.write('youtube', { refresh_token: 'R', scope: YT_FORCE_SSL_SCOPE }); const store = new Store(':memory:'); seed(store, 1, 'funny', 'V1', 1);
    store.exec(`UPDATE channels SET config_json=? WHERE id=1`, JSON.stringify({ liveUrl: 'https://www.youtube.com/@teamunknown/live' }));
    const mk = (o: Record<string, unknown>) => loadConfig(process.cwd(), { dataDir: dir, overrides: o });
    assert.equal((await funnelTick(store, mk({ automation: { funnelComment: true } }))).posted, 0, 'comment gate closed'); assert.equal(s.st.comments.length, 0);
    const cfg = mk({ automation: { funnelComment: true }, gates: { commentsAutoPost: true } });
    assert.equal((await funnelTick(store, cfg)).posted, 1); assert.equal((await funnelTick(store, cfg)).posted, 0, 'once only');
    assert.match(JSON.stringify(s.st.comments[0]), /teamunknown\/live/); assert.equal((s.st.comments[0] as { snippet: { videoId: string } }).snippet.videoId, 'V1');
  } finally { s.close(); process.env = old; }
});
