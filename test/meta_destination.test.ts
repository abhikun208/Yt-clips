import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { adapterFor } from '../src/publish/service.ts';
import { tmpDir } from './helpers.ts';

test('a job for a CHOSEN Facebook Page / Instagram account posts to exactly that account (never the channel default); no publish permission => manual flow; missing Page => clear error', async () => {
  const hits: string[] = []; const toks: string[] = [];
  const srv = createServer((req, res) => { const ch: Buffer[] = []; req.on('data', (c) => ch.push(c)); req.on('end', () => {
    const u = new URL(req.url!, 'http://x'); const f = new URLSearchParams(Buffer.concat(ch).toString()); hits.push(`${u.pathname} ${f.get('upload_phase') ?? f.get('media_type') ?? ''}`); if (f.get('access_token')) toks.push(f.get('access_token')!);
    const send = (j: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (/\/video_reels$/.test(u.pathname)) return send(f.get('upload_phase') === 'start' ? { video_id: 'V1', upload_url: `${base}/video-upload/V1` } : { success: true });
    if (u.pathname.startsWith('/video-upload/') || u.pathname.startsWith('/ig-api-upload/')) return send({ success: true });
    if (/\/media$/.test(u.pathname)) return send({ id: 'C1' }); if (u.pathname === '/C1') return send({ status_code: 'FINISHED' }); if (/media_publish$/.test(u.pathname)) return send({ id: 'M1' });
    res.writeHead(404); res.end('{}'); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`; const old = { ...process.env };
  Object.assign(process.env, { GRAPH_API_BASE: base, META_RUPLOAD_BASE: base, META_POLL_MS: '5' }); delete process.env.PUBLIC_URL;
  try {
    const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(':memory:'); const sec = SecretStore.forData(dataDir);
    const perms = ['pages_show_list', 'pages_manage_posts', 'instagram_content_publish'];
    sec.write('meta-pages', { pages: [{ id: 'PA', name: 'Default Page', access_token: 'TOK-A', ig_user_id: 'IGA' }, { id: 'PB', name: 'Raj oo1', access_token: 'TOK-B', ig_user_id: 'IGB', ut: 'USER-B' }], user_token: 'USER', perms });
    sec.write('facebook', { page_id: 'PA', access_token: 'TOK-A', perms }); sec.write('instagram', { ig_user_id: 'IGA', page_token: 'TOK-A', access_token: 'USER', perms });
    const dest = (id: string, plat: string, ext: string, ref: string) => store.exec(`INSERT INTO destinations(id, platform, external_id, name, secret_ref) VALUES (?,?,?,?,?)`, id, plat, ext, id, ref);
    dest('fb:PB', 'facebook', 'PB', 'meta-pages#PB'); dest('ig:IGB', 'instagram', 'IGB', 'meta-pages#PB'); dest('fb:GONE', 'facebook', 'GONE', 'meta-pages#GONE');
    const file = join(tmpDir(), 'c.mp4'); writeFileSync(file, Buffer.alloc(2048, 1)); const req = (k: string) => ({ filePath: file, title: 'T', description: 'D', tags: [], visibility: 'unlisted' as const, idempotencyKey: k });

    const fb = adapterFor(store, cfg, 'facebook_reels', undefined, 'fb:PB'); const u1 = await fb.upload(req('k1')); await fb.publish(u1.remoteId, null);
    assert.ok(hits.some((h) => h.startsWith('/PB/video_reels')), hits.join(' | ')); assert.ok(!hits.some((h) => h.startsWith('/PA/')), 'the default Page is never touched'); assert.ok(toks.every((t) => t === 'TOK-B'), `tokens: ${toks}`);

    hits.length = 0; toks.length = 0; const ig = adapterFor(store, cfg, 'instagram_reels', undefined, 'ig:IGB'); const u2 = await ig.upload(req('k2')); await ig.publish(u2.remoteId, null);
    assert.ok(hits.some((h) => h.startsWith('/IGB/media')), hits.join(' | ')); assert.ok(!hits.some((h) => h.startsWith('/IGA/')), 'the default Instagram is never touched'); assert.ok(toks.every((t) => t === 'TOK-B'), `ig tokens: ${toks}`);

    // login without publish permission => manual-post flow for that account (no network)
    sec.write('meta-pages', { pages: [{ id: 'PB', name: 'Raj oo1', access_token: 'TOK-B', ig_user_id: 'IGB' }], user_token: 'USER', perms: ['pages_show_list'] }); hits.length = 0;
    const man = adapterFor(store, cfg, 'facebook_reels', undefined, 'fb:PB'); assert.equal(man.constructor.name, 'ManualAdapter');
    // a Page that is no longer in the login must fail loudly, not post somewhere else
    assert.throws(() => adapterFor(store, cfg, 'facebook_reels', undefined, 'fb:GONE'), /AUTH_NOT_CONNECTED: Page GONE/);
    assert.equal(hits.length, 0);
  } finally { srv.close(); process.env = old; }
});
