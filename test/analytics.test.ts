import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/db.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { TokenProvider } from '../src/publish/oauth.ts';
import { YouTubeAdapter } from '../src/publish/youtube.ts';
import { youtubeProvider, instagramProvider, facebookProvider, tiktokProvider } from '../src/analytics/providers.ts';
import { collectAnalytics, analyticsSummary } from '../src/analytics/collect.ts';
import { hourStats } from '../src/schedule/analytics.ts';
import { startFake } from './fakeGoogle.ts';
import { tmpDir } from './helpers.ts';

interface Hit { m: string; path: string; q: URLSearchParams; auth?: string; body: string }
async function fakeSocial(): Promise<{ s: Server; base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const u = new URL(req.url!, 'http://x');
    hits.push({ m: req.method!, path: u.pathname, q: u.searchParams, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    const send = (c: number, b: unknown) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const tok = u.searchParams.get('access_token');
    if (u.pathname.startsWith('/g/')) {
      if (tok !== 'IGTOKEN-123456' && tok !== 'FBTOKEN-123456') return send(401, { error: { code: 190, message: 'bad' } });
      const id = u.pathname.split('/')[2]!;
      if (u.pathname.endsWith('/insights')) { if (id === 'ig_noaccess') return send(400, { error: { code: 100 } }); if ((u.searchParams.get('metric') ?? '').includes('reach') && id === 'ig_viewsonly') return send(400, { error: { code: 100, message: 'metric not supported' } });
        return send(200, { data: (u.searchParams.get('metric') ?? '').split(',').map((n) => ({ name: n, period: 'lifetime', values: [{ value: n === 'ig_reels_avg_watch_time' ? 4500 : 100 + n.length }] })) }); }
      if (u.pathname.endsWith('/video_insights')) return send(200, { data: [{ name: 'total_video_views', period: 'lifetime', values: [{ value: 777 }] }] });
      return send(200, { id, timestamp: '2026-10-02T13:00:00+0000', created_time: '2026-10-03T08:00:00+0000' });
    }
    if (u.pathname === '/v2/video/query/') { if (req.headers.authorization !== 'Bearer TTTOKEN-123456') return send(401, {}); const ids = JSON.parse(Buffer.concat(chunks).toString()).filters.video_ids as string[]; return send(200, { data: { videos: ids.map((id, i) => ({ id, create_time: 1790000000 + i, view_count: 4000 + i, like_count: 9, comment_count: 1, share_count: 2 })) }, error: { code: 'ok' } }); }
    send(404, {});
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok)); return { s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits };
}
function addUpload(store: Store, n: number, platform: string, remote: string, state = 'PUBLISHED') {
  store.exec(`INSERT OR IGNORE INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT OR IGNORE INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,10,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id) VALUES (?,1,?)`, n, `o${n}`); store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, remote_id) VALUES (?,?,?,?,?)`, n, platform, state, `${platform}:o${n}`, remote);
}

test('ALL platforms: YouTube + Instagram + Facebook + TikTok providers collect real-shaped stats; one platform failing never blocks others; unpublished ignored', async () => {
  const g = await startFake(); const so = await fakeSocial(); const old = { ...process.env };
  Object.assign(process.env, { YT_API_BASE: g.base, YT_OAUTH_BASE: g.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's', GRAPH_API_BASE: `${so.base}/g`, TIKTOK_API_BASE: so.base });
  try {
    const dir = tmpDir(); const secrets = new SecretStore(join(dir, 's'), undefined); secrets.write('youtube', { refresh_token: 'REFRESH-TOKEN-XYZ' });
    secrets.write('instagram', { access_token: 'IGTOKEN-123456' }); secrets.write('tiktok', { access_token: 'TTTOKEN-123456' }); // facebook intentionally NOT connected
    const store = new Store(':memory:'); const tp = new TokenProvider(secrets); const yt = new YouTubeAdapter(store, tp, { sleep: async () => {} });
    const file = join(dir, 'c.mp4'); writeFileSync(file, randomBytes(300 * 1024)); const up = await yt.upload({ filePath: file, title: 't', description: 'd', tags: [], visibility: 'unlisted', idempotencyKey: 'k' });
    addUpload(store, 1, 'youtube_shorts', up.remoteId); addUpload(store, 2, 'instagram_reels', 'ig_ok'); addUpload(store, 3, 'instagram_reels', 'ig_viewsonly'); addUpload(store, 4, 'instagram_reels', 'ig_noaccess');
    addUpload(store, 5, 'facebook_reels', 'fb1'); addUpload(store, 6, 'tiktok', 'tt1'); addUpload(store, 7, 'tiktok', 'tt2'); addUpload(store, 8, 'tiktok', 'tt_unpub', 'UNLISTED_VERIFIED');
    const prov = [youtubeProvider(yt, () => tp.connected()), instagramProvider(secrets), facebookProvider(secrets), tiktokProvider(secrets)];
    const r = await collectAnalytics(store, prov); const by = Object.fromEntries(r.map((x) => [x.platform, x]));
    assert.equal(by.youtube_shorts!.recorded, 1); assert.equal(by.instagram_reels!.recorded, 2, 'ig_noaccess skipped, not fabricated'); assert.equal(by.facebook_reels!.requested, 0, 'not connected => skipped'); assert.equal(by.tiktok!.recorded, 2);
    const snap = (rid: string) => store.get<any>('SELECT * FROM analytics_snapshots WHERE remote_id=?', rid);
    assert.equal(snap(up.remoteId).views, 1234); assert.equal(snap(up.remoteId).likes, 56); assert.equal(snap('ig_ok').views, 105); assert.equal(snap('ig_ok').avg_watch_sec, 4.5); assert.equal(snap('ig_viewsonly').views, 105, 'fallback to views-only works'); assert.equal(snap('ig_viewsonly').reach, null);
    assert.equal(snap('tt1').views, 4000); assert.equal(snap('tt1').shares, 2); assert.equal(snap('tt_unpub'), undefined, 'unpublished upload never queried');
    const ttReq = so.hits.find((h) => h.path === '/v2/video/query/')!; assert.equal(ttReq.m, 'POST'); assert.match(ttReq.q.get('fields')!, /view_count/); assert.deepEqual(JSON.parse(ttReq.body).filters.video_ids, ['tt1', 'tt2']);
    // facebook connects later -> collected on next cycle
    secrets.write('facebook', { access_token: 'FBTOKEN-123456' }); const r2 = await collectAnalytics(store, prov); assert.equal(r2.find((x) => x.platform === 'facebook_reels')!.recorded, 1); assert.equal(snap('fb1').views, 777);
    // feeds the scheduler per platform + summary
    assert.ok(hourStats(store, 'UTC', 'youtube_shorts').length >= 1); assert.equal(hourStats(store, 'UTC', 'tiktok').reduce((a, x) => a + x.samples, 0), 2);
    const sum = analyticsSummary(store, 'UTC', (pl) => hourStats(store, 'UTC', pl)); assert.deepEqual(sum.map((x) => x.platform).sort(), ['facebook_reels', 'instagram_reels', 'tiktok', 'youtube_shorts']); assert.equal(sum.find((x) => x.platform === 'tiktok')!.totalViews, 8001);
    // bad token on one platform => error reported for it only
    secrets.write('instagram', { access_token: 'WRONGTOKEN-1234' }); const r3 = await collectAnalytics(store, prov); assert.match(r3.find((x) => x.platform === 'instagram_reels')!.error!, /AUTH_REVOKED/); assert.equal(r3.find((x) => x.platform === 'tiktok')!.recorded, 2);
  } finally { await g.close(); await new Promise((ok) => so.s.close(ok)); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
