import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, type App } from '../src/server/app.ts';
import { tmpDir, makeFixture } from './helpers.ts';

const TOKEN = 'test-token-0123456789';
const small = { clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 2, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } };
async function boot(extra: Record<string, unknown> = {}): Promise<{ app: App; base: string }> {
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false, overrides: small, ...extra });
  const port = await app.start(); return { app, base: `http://127.0.0.1:${port}` };
}
const auth = { authorization: `Bearer ${TOKEN}` };
const wait = async (f: () => Promise<boolean>, ms = 240_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 400)); } return false; };

test('startup guards: no token on public host, short token', () => {
  assert.throws(() => createApp({ host: '0.0.0.0', token: '', dataDir: tmpDir() }), /non-loopback.*YT_CLIPS_TOKEN/);
  assert.throws(() => createApp({ host: '127.0.0.1', token: 'short', dataDir: tmpDir() }), /at least 12/);
});

test('auth: healthz open; API needs token; cookie login; CSRF header; brute-force limit', async () => {
  const { app, base } = await boot();
  try {
    const h = await (await fetch(`${base}/healthz`)).json() as any; assert.equal(h.ok, true); assert.ok(!JSON.stringify(h).includes(TOKEN));
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer wrong-token-xxxxxxx' } })).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-api-key': TOKEN } })).status, 200);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: auth });
    const cookie = login.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const ck = cookie.split(';')[0]!;
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: ck } })).status, 200, 'cookie auth works (for <video>/<img>)');
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', headers: { cookie: ck } })).status, 403, 'cookie POST without x-ytc blocked (CSRF)');
    const html = await (await fetch(`${base}/`)).text(); assert.match(html, /yt-clips/);
  } finally { await app.stop(); }
  const b2 = await boot();
  try {
    let last = 0; for (let i = 0; i < 12; i++) last = (await fetch(`${b2.base}/api/status`, { headers: { authorization: 'Bearer nope-nope-nope-nope' } })).status;
    assert.equal(last, 429, 'repeated bad tokens are rate limited');
  } finally { await b2.app.stop(); }
});

test('presets API, real preview PNG, config whitelist (gates can NEVER be changed via API)', async () => {
  const { app, base } = await boot();
  try {
    const pr = await (await fetch(`${base}/api/presets`, { headers: auth })).json() as any; assert.ok(pr.presets.length >= 72); assert.equal(pr.current, 'classic-sun');
    const img = await fetch(`${base}/api/presets/glow-sky/preview.png`, { headers: auth }); assert.equal(img.status, 200);
    const buf = Buffer.from(await img.arrayBuffer()); assert.equal(buf.subarray(1, 4).toString(), 'PNG'); assert.ok(buf.length > 2000);
    assert.equal((await fetch(`${base}/api/presets/nope/preview.png`, { headers: auth })).status, 404);
    const post = (b: unknown) => fetch(`${base}/api/config`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await post({ captionPreset: 'karaoke-gold' })).status, 200); assert.equal(app.cfg.edit.captionPreset, 'karaoke-gold');
    assert.equal((await post({ captionPreset: 'bogus' })).status, 400);
    for (const bad of [{ gates: { publishEnabled: true } }, { publishEnabled: true }, { dbPath: '/etc/x' }]) assert.equal((await post(bad)).status, 400);
    assert.deepEqual(app.cfg.gates, { publishEnabled: false, commentsAutoPost: false, publicVisibilityAllowed: false });
    const saved = JSON.parse(readFileSync(join(app.cfg.dataDir, 'config.json'), 'utf8')); assert.equal(saved.edit.captionPreset, 'karaoke-gold'); assert.ok(!('gates' in saved));
    assert.equal((await post({ reframe: 'weird' })).status, 400);
  } finally { await app.stop(); }
});

test('upload -> automatic pipeline -> clips with QC pass, range streaming, manifest, SRT, path safety, transcript endpoint', { timeout: 280_000 }, async () => {
  const { app, base } = await boot();
  try {
    const src = join(tmpDir(), 'in.mp4'); await makeFixture(src, 24); const body = readFileSync(src);
    assert.equal((await fetch(`${base}/api/upload?name=a.mp4`, { method: 'POST', headers: auth, body })).status, 400, 'rights confirmation required');
    assert.equal((await fetch(`${base}/api/upload?authorized=1&name=bad.mp4`, { method: 'POST', headers: auth, body: Buffer.from('nope') })).status, 400, 'corrupt upload rejected');
    const up = await (await fetch(`${base}/api/upload?authorized=1&name=in.mp4`, { method: 'POST', headers: auth, body })).json() as any; assert.equal(up.ok, true); assert.equal(up.duplicate, false);
    assert.equal(((await (await fetch(`${base}/api/upload?authorized=1&name=in.mp4`, { method: 'POST', headers: auth, body })).json()) as any).duplicate, true);
    const done = await wait(async () => { const s = await (await fetch(`${base}/api/status`, { headers: auth })).json() as any; const cl = await (await fetch(`${base}/api/clips`, { headers: auth })).json() as any; return !s.running && cl.clips.length > 0 && cl.clips.every((c: any) => c.title); });
    if (!done) { const s = await (await fetch(`${base}/api/status`, { headers: auth })).json() as any; const cl = await (await fetch(`${base}/api/clips`, { headers: auth })).json() as any; console.error('PIPELINE DIAG', JSON.stringify({ status: s, clips: cl.clips.map((c: any) => ({ title: c.title, qc: c.qcPass })) }).slice(0, 1500)); }
    assert.ok(done, 'pipeline finished (see PIPELINE DIAG above)'); 
    const { clips } = await (await fetch(`${base}/api/clips`, { headers: auth })).json() as any; const c = clips[0];
    assert.equal(c.qcPass, true); assert.ok(c.title && c.tags.length >= 0); assert.ok(c.thumb);
    const full = await fetch(`${base}${c.video}`, { headers: auth }); const size = Number(full.headers.get('content-length')); assert.ok(size > 1000); assert.equal(full.headers.get('accept-ranges'), 'bytes'); await full.arrayBuffer();
    const part = await fetch(`${base}${c.video}`, { headers: { ...auth, range: 'bytes=0-99' } }); assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`); assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(`${base}${c.video}`, { headers: { ...auth, range: `bytes=${size + 5}-` } })).status, 416);
    assert.equal((await fetch(`${base}${c.video}`, { method: 'HEAD', headers: auth })).status, 200);
    for (const bad of ['/files/edited/..%2F..%2Fetc%2Fpasswd', '/files/edited/..', '/files/edited/a%00.mp4', '/files/secret/x.mp4', '/files/edited/nope.mp4']) assert.equal((await fetch(`${base}${bad}`, { headers: auth })).status, 404, bad);
    assert.equal((await fetch(`${base}${c.video}`)).status, 401, 'files need auth');
    const mf = await (await fetch(`${base}/api/manifest/${c.outputId}`, { headers: auth })).json() as any; assert.equal(mf.qc.pass, true); assert.equal(mf.outputId, c.outputId);
    assert.equal((await fetch(`${base}/api/manifest/..%2Fx`, { headers: auth })).status, 404);
    // transcript endpoint writes sidecar and re-queues analysis
    const vid = app.store.get<{ id: number; path: string }>('SELECT id, path FROM videos')!;
    assert.equal((await fetch(`${base}/api/transcript?video=${vid.id}&format=exe`, { method: 'POST', headers: auth, body: 'x' })).status, 400);
    assert.equal((await fetch(`${base}/api/transcript?video=999&format=srt`, { method: 'POST', headers: auth, body: 'x' })).status, 404);
    assert.equal((await fetch(`${base}/api/transcript?video=${vid.id}&format=srt`, { method: 'POST', headers: auth, body: '1\n00:00:06,000 --> 00:00:09,000\nye secret hai\n' })).status, 200);
    assert.ok(existsSync(vid.path.replace(/\.[^.]+$/, '') + '.srt'));
  } finally { await app.stop(); }
});

test('graceful stop resolves quickly when idle and closes the DB', async () => {
  const { app } = await boot(); const t0 = Date.now(); await app.stop(); assert.ok(Date.now() - t0 < 5000);
});

test('UI: served script is valid JavaScript and contains the publishing/comments/analytics/editor panels; /api/videos works', async () => {
  const { app, base } = await boot();
  try {
    const html = await (await fetch(`${base}/`)).text(); const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    assert.doesNotThrow(() => new Function(script), 'UI script must parse');
    for (const id of ['ytc', 'qgo', 'ccol', 'acol', 'csvgo', 'eload', 'esave']) assert.ok(html.includes(`id="${id}"`), id);
    app.store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1, '/a/b/talk.mp4', 'f')`);
    const v = await (await fetch(`${base}/api/videos`, { headers: auth })).json() as any; assert.equal(v.videos[0].title, 'talk.mp4');
    for (const p of ['/api/uploads', '/api/comments', '/api/analytics', '/api/schedule?n=2', '/api/youtube', '/api/platforms']) assert.equal((await fetch(`${base}${p}`, { headers: auth })).status, 200, p);
  } finally { await app.stop(); }
});
