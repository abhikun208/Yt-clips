import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { FacebookReelsAdapter, InstagramReelsAdapter, publicClipLink } from '../src/publish/meta.ts';
import { tmpDir } from './helpers.ts';

/** Local stand-in shaped like Meta's documented Reels endpoints (NOT real Meta). */
async function stub() {
  const log: string[] = []; const st = { statusCalls: 0 };
  const srv = createServer((req, res) => { const ch: Buffer[] = []; req.on('data', (c) => ch.push(c)); req.on('end', () => {
    const u = new URL(req.url!, 'http://x'); const body = Buffer.concat(ch); const f = new URLSearchParams(body.toString()); log.push(`${req.method} ${u.pathname} ${f.get('upload_phase') ?? f.get('media_type') ?? ''}`);
    const send = (j: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/PAGE1/video_reels') { if (f.get('upload_phase') === 'start') return send({ video_id: 'V9', upload_url: `${base}/video-upload/V9` }); assert.equal(f.get('video_state'), 'PUBLISHED'); return send({ success: true }); }
    if (u.pathname === '/video-upload/V9') { assert.equal(req.headers.authorization, 'OAuth PAGETOK'); assert.equal(req.headers.file_size, String(body.length)); assert.equal(req.headers.offset, '0'); return send({ success: true }); }
    if (u.pathname === '/IG1/media') { assert.equal(f.get('media_type'), 'REELS'); assert.ok(f.get('video_url') || f.get('upload_type') === 'resumable'); return send({ id: 'C7' }); }
    if (u.pathname.startsWith('/ig-api-upload/')) return send({ success: true });
    if (u.pathname === '/C7') return send({ status_code: ++st.statusCalls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
    if (u.pathname === '/IG1/media_publish') { assert.equal(f.get('creation_id'), 'C7'); return send({ id: 'M55' }); }
    res.writeHead(404); res.end('{}'); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`; return { base, log, close: () => srv.close() };
}
test('Meta Reels adapters: Facebook start/upload/finish, Instagram container/poll/publish (resumable + public-link variants), staged until publish, idempotent', async () => {
  const s = await stub(); process.env.GRAPH_API_BASE = s.base; process.env.META_RUPLOAD_BASE = s.base; process.env.META_POLL_MS = '5';
  try {
    const store = new Store(join(tmpDir(), 'a.db')); const file = join(tmpDir(), 'c.mp4'); writeFileSync(file, Buffer.alloc(4096, 1));
    const fb = new FacebookReelsAdapter(store, { page_id: 'PAGE1', access_token: 'PAGETOK' }); const up = await fb.upload({ filePath: file, title: 'T', description: 'D', tags: [], visibility: 'unlisted', idempotencyKey: 'k1' });
    assert.equal(s.log.length, 0, 'upload() never touches the network'); const r1 = await fb.publish(up.remoteId, null); assert.equal((r1 as any).remoteId, 'facebook:V9'); assert.deepEqual(s.log.map((x) => x.trim()), ['POST /PAGE1/video_reels start', 'POST /video-upload/V9', 'POST /PAGE1/video_reels finish']);
    const n = s.log.length; await fb.publish(up.remoteId, null); assert.equal(s.log.length, n, 'second publish is idempotent');
    s.log.length = 0; delete process.env.PUBLIC_URL; const ig = new InstagramReelsAdapter(store, { ig_user_id: 'IG1', page_token: 'PAGETOK', access_token: 'USER' }); const u2 = await ig.upload({ filePath: file, title: 'T', description: 'D', tags: [], visibility: 'unlisted', idempotencyKey: 'k2' });
    assert.equal(((await ig.publish(u2.remoteId, null)) as any).remoteId, 'instagram:M55'); assert.ok(s.log.some((x) => x.includes('/ig-api-upload/')), 'no public URL -> resumable');
    s.log.length = 0; process.env.PUBLIC_URL = 'https://clips.example.com'; const u3 = await ig.upload({ filePath: file, title: 'T2', description: 'D', tags: [], visibility: 'unlisted', idempotencyKey: 'k3' });
    assert.equal(((await ig.publish(u3.remoteId, null)) as any).remoteId, 'instagram:M55'); assert.ok(!s.log.some((x) => x.includes('/ig-api-upload/')), 'public URL -> video_url path');
    assert.match(publicClipLink(store, file, 'https://x.y'), /^https:\/\/x\.y\/pub\/[a-f0-9]{48}\.mp4$/);
  } finally { s.close(); delete process.env.GRAPH_API_BASE; delete process.env.META_RUPLOAD_BASE; delete process.env.META_POLL_MS; delete process.env.PUBLIC_URL; }
});
