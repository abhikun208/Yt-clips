import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { cuesFromApi, transcribeViaApi } from '../src/analysis/sttApi.ts';
import { transcribeVideo } from '../src/analysis/stt.ts';
import { loadTranscript } from '../src/analysis/transcript.ts';
import { loadConfig } from '../src/config.ts';
import { saveAi, aiStatus, sttCreds } from '../src/ai/settings.ts';
import { createApp } from '../src/server/app.ts';
import { Store } from '../src/db.ts';
import { startAuth, handleCallback, tiktokAccessToken, saveAppCreds } from '../src/publish/socialOauth.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { tmpDir, makeFixture } from './helpers.ts';

interface Hit { path: string; auth?: string; ctype?: string; body: string }
async function fakeStt(plan: (n: number) => 'ok' | '429' | '500' = () => 'ok'): Promise<{ s: Server; base: string; hits: Hit[] }> {
  const hits: Hit[] = []; let n = 0;
  const s = createServer(async (req, res) => {
    const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer); const body = Buffer.concat(ch).toString('latin1'); hits.push({ path: req.url!, auth: req.headers.authorization, ctype: req.headers['content-type'], body });
    const mode = plan(++n); if (mode === '429') { res.writeHead(429, { 'retry-after': '0' }); return void res.end('{}'); } if (mode === '500') { res.writeHead(500); return void res.end('x'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ language: 'hindi', text: 'namaste dosto aaj', segments: [{ start: 0, end: 2.5, text: ' namaste dosto aaj' }], words: [{ word: 'namaste', start: 0.1, end: 0.8 }, { word: 'dosto', start: 0.9, end: 1.5 }, { word: 'aaj', start: 1.6, end: 2.2 }] }));
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok)); return { s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits };
}

test('cuesFromApi: words (top-level or per segment) attach to cues with offset; no segments => grouped cues; junk dropped', () => {
  const c = cuesFromApi({ segments: [{ start: 0, end: 2, text: 'a b' }, { start: 2, end: 2, text: 'zero' }], words: [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 1, end: 2 }, { word: '', start: 1, end: 1.5 }] }, 10);
  assert.equal(c.length, 1); assert.equal(c[0]!.start, 10); assert.deepEqual(c[0]!.words!.map((w) => [w.text, w.start]), [['a', 10], ['b', 11]]);
  const g = cuesFromApi({ words: Array.from({ length: 20 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 0.8 })) }); assert.ok(g.length >= 3 && g.every((x) => x.words!.length > 0));
});

test('API speech-to-text: real ffmpeg audio chunks, correct request (auth, model, word timestamps), offsets back to full timeline, retries 429/500', async () => {
  const f = await fakeStt((n) => (n === 1 ? '429' : n === 2 ? '500' : 'ok')); const d = tmpDir(); const v = join(d, 'v.mp4'); await makeFixture(v, 4); // ~12s
  try {
    const r = await transcribeViaApi(v, join(d, 't'), { baseUrl: f.base, apiKey: 'gsk_testkey1', model: 'whisper-large-v3-turbo' }, { chunkSec: 5, language: 'hi' });
    assert.equal(r.language, 'hindi'); assert.ok(r.cues.length >= 3, `cues ${r.cues.length}`); assert.ok(r.cues[1]!.start >= 5 - 0.01 && r.cues[1]!.words![0]!.start >= 5, 'second chunk offset by 5s'); assert.ok(r.cues[2]!.start >= 10 - 0.01);
    const h = f.hits.find((x) => x.body.includes('whisper-large-v3-turbo'))!; assert.equal(h.path, '/audio/transcriptions'); assert.equal(h.auth, 'Bearer gsk_testkey1'); assert.match(h.ctype!, /multipart\/form-data/);
    for (const frag of ['name="response_format"', 'verbose_json', 'timestamp_granularities[]', 'word', 'name="language"', 'OggS']) assert.ok(h.body.includes(frag), frag);
    assert.ok(f.hits.length >= 5, 'retries happened');
  } finally { await new Promise((ok) => f.s.close(ok)); }
});

test('transcribeVideo uses the saved API key (UI-saved, not env): sidecar json written with real word timing; bad key => failed status, no crash; status never leaks the key', async () => {
  const f = await fakeStt(); const d = tmpDir(); const v = join(d, 'v.mp4'); await makeFixture(v, 3);
  const cfg = loadConfig(process.cwd(), { dataDir: join(d, 'data') }); assert.equal(sttCreds(cfg), null);
  saveAi(cfg, 'stt', { apiKey: 'gsk_savedkey123', baseUrl: f.base }); const st = aiStatus(cfg); assert.equal(st.stt.ready, true); assert.ok(!JSON.stringify(st).includes('gsk_savedkey123'));
  try {
    const r = await transcribeVideo(cfg, v); assert.equal(r.status, 'ok'); assert.equal(r.engine, 'api'); const cues = loadTranscript(v.replace(/\.mp4$/, '')); assert.ok(cues.length >= 1 && cues[0]!.words!.length === 3);
    assert.throws(() => saveAi(cfg, 'stt', { apiKey: 'x' }), /invalid/); assert.throws(() => saveAi(cfg, 'llm', { apiKey: 'longenoughkey', baseUrl: 'ftp://x' }), /invalid/);
  } finally { await new Promise((ok) => f.s.close(ok)); }
});

test('settings API: save key (not echoed), oauth app creds, status; callback is reachable without cookie but needs a valid one-time state', async () => {
  const TOKEN = 'test-token-0123456789'; const h = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    assert.equal((await fetch(`${base}/api/settings`)).status, 401);
    const r0 = await (await fetch(`${base}/api/settings`, { headers: h })).json() as any; assert.equal(r0.ai.stt.ready, false);
    assert.equal((await fetch(`${base}/api/settings/ai`, { method: 'POST', headers: h, body: JSON.stringify({ kind: 'stt', apiKey: 'gsk_abcdefgh123' }) })).status, 200);
    const r1 = await (await fetch(`${base}/api/settings`, { headers: h })).json() as any; assert.equal(r1.ai.stt.ready, true); assert.ok(!JSON.stringify(r1).includes('gsk_abcdefgh123')); assert.match(r1.callbackBase, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${base}/api/oauth/facebook/start`, { headers: h })).status, 400, 'no app creds yet');
    assert.equal((await fetch(`${base}/api/settings/oauth-app`, { method: 'POST', headers: h, body: JSON.stringify({ app: 'facebook', clientId: 'APPID1234', clientSecret: 'secretsecret1' }) })).status, 200);
    const st = await (await fetch(`${base}/api/oauth/facebook/start`, { headers: h })).json() as any; const u = new URL(st.authUrl); assert.equal(u.searchParams.get('client_id'), 'APPID1234'); assert.equal(u.searchParams.get('redirect_uri'), `${base}/api/oauth/facebook/callback`); assert.match(u.searchParams.get('scope')!, /instagram_manage_insights/);
    const bad = await fetch(`${base}/api/oauth/facebook/callback?code=x&state=nope`); assert.equal(bad.status, 200); assert.match(await bad.text(), /Failed: .*state/);
  } finally { await app.stop(); }
});

test('social login: Facebook (code -> long-lived -> page token + linked Instagram) and TikTok (code -> tokens, auto-refresh after expiry), state is one-time', async () => {
  const hits: string[] = [];
  const s = createServer(async (req, res) => {
    const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer); const u = new URL(req.url!, 'http://x'); const body = Buffer.concat(ch).toString(); hits.push(`${req.method} ${u.pathname}?${u.search}${body}`);
    const send = (j: unknown, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/g/oauth/access_token') { if (u.searchParams.get('grant_type') === 'fb_exchange_token') return send({ access_token: 'LONGUSERTOKEN' }); return u.searchParams.get('code') === 'GOODCODE' ? send({ access_token: 'SHORTTOKEN' }) : send({ error: { message: 'bad code' } }, 400); }
    if (u.pathname === '/g/me/accounts') return send({ data: [{ id: 'P1', name: 'NoIG', access_token: 'PT1' }, { id: 'P2', name: 'WithIG', access_token: 'PT2', instagram_business_account: { id: 'IG9' } }] });
    if (u.pathname === '/v2/oauth/token/') { const p = new URLSearchParams(body); if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'TTCODE' ? send({ access_token: 'TTACCESS1', refresh_token: 'TTREFRESH1', open_id: 'oid', expires_in: 1, refresh_expires_in: 31536000 }) : send({ error: 'invalid_grant' }, 400); if (p.get('refresh_token') === 'TTREFRESH1') return send({ access_token: 'TTACCESS2', refresh_token: 'TTREFRESH2', expires_in: 86400 }); return send({ error: 'invalid_grant' }, 400); }
    send({}, 404);
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok)); const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`; const old = { ...process.env };
  Object.assign(process.env, { GRAPH_API_BASE: `${b}/g`, TIKTOK_API_BASE: b });
  try {
    const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(':memory:'); const sec = new SecretStore(join(dataDir, 'secrets'), undefined);
    saveAppCreds(cfg, 'facebook', 'APPID1234', 'secretsecret1'); saveAppCreds(cfg, 'tiktok', 'TTKEY1234', 'ttsecret1234');
    const base = 'http://127.0.0.1:8090'; const st = new URL(startAuth(store, cfg, 'facebook', base)).searchParams.get('state')!;
    await assert.rejects(handleCallback(store, cfg, 'facebook', { code: 'GOODCODE', state: 'wrong' }, base), /state/);
    const r = await handleCallback(store, cfg, 'facebook', { code: 'GOODCODE', state: st }, base); assert.deepEqual(r.connected, ['facebook', 'instagram']);
    assert.deepEqual(sec.read<any>('facebook').access_token, 'PT2'); assert.equal(sec.read<any>('instagram').ig_user_id, 'IG9'); assert.equal(sec.read<any>('instagram').access_token, 'LONGUSERTOKEN');
    await assert.rejects(handleCallback(store, cfg, 'facebook', { code: 'GOODCODE', state: st }, base), /state/, 'state is one-time');
    const t = new URL(startAuth(store, cfg, 'tiktok', base)); assert.equal(t.searchParams.get('client_key'), 'TTKEY1234'); assert.equal(t.searchParams.get('response_type'), 'code');
    const tr = await handleCallback(store, cfg, 'tiktok', { code: 'TTCODE', state: t.searchParams.get('state') }, base); assert.deepEqual(tr.connected, ['tiktok']);
    await new Promise((ok) => setTimeout(ok, 1200)); assert.equal(await tiktokAccessToken(cfg), 'TTACCESS2', 'expired access token is refreshed'); assert.equal(sec.read<any>('tiktok').refresh_token, 'TTREFRESH2');
    assert.ok(hits.some((x) => x.includes('grant_type=refresh_token')));
  } finally { await new Promise((ok) => s.close(ok)); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});

test('END TO END with AI: upload -> API transcript -> clips with MEASURED captions burned in + LLM titles/tags from the real transcript (fake AI server, real ffmpeg)', async () => {
  const words = Array.from({ length: 56 }, (_, i) => ({ word: ['cricket', 'match', 'ka', 'sach', 'dekho', 'bhai', 'ye', 'kya'][i % 8]!, start: 4 + i * 0.4, end: 4 + i * 0.4 + 0.35 }));
  const seen: string[] = [];
  const ai = createServer(async (req, res) => {
    const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer); const body = Buffer.concat(ch).toString('latin1'); seen.push(req.url!); res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/audio/transcriptions') return void res.end(JSON.stringify({ language: 'hindi', segments: [{ start: 4, end: 26, text: words.map((w) => w.word).join(' ') }], words }));
    if (req.url === '/chat/completions') { assert.ok(JSON.parse(body).messages[0].content.includes('cricket match')); return void res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Cricket Match Ka Sach 😱', titles: ['Match ka asli sach', 'Cricket ka raaz'], description: 'Cricket match ka sach is clip mein.', tags: ['cricket', 'match', 'sach'], thumbnailText: 'MATCH KA SACH' }) } }] })); }
    res.end('{}');
  });
  await new Promise<void>((ok) => ai.listen(0, '127.0.0.1', ok)); const aib = `http://127.0.0.1:${(ai.address() as { port: number }).port}`;
  const TOKEN = 'test-token-0123456789'; const h = { authorization: `Bearer ${TOKEN}` };
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: true, loopSeconds: 1, overrides: { clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 1, minScore: 0.1 }, edit: { width: 270, height: 480, preset: 'ultrafast' } } });
  saveAi(app.cfg, 'stt', { apiKey: 'gsk_e2ekey1234', baseUrl: aib }); saveAi(app.cfg, 'llm', { apiKey: 'gsk_e2ekey1234', baseUrl: aib });
  const base = `http://127.0.0.1:${await app.start()}`; const d = tmpDir(); const v = join(d, 'v.mp4'); await makeFixture(v, 20);
  try {
    const { readFileSync } = await import('node:fs'); const up = await fetch(`${base}/api/upload?authorized=1&name=v.mp4`, { method: 'POST', headers: h, body: readFileSync(v) }); assert.equal(up.status, 200);
    let clips: any[] = []; const t0 = Date.now(); while (Date.now() - t0 < 200_000) { clips = ((await (await fetch(`${base}/api/clips`, { headers: h })).json()) as any).clips; if (clips.length && clips[0].title) break; await new Promise((ok) => setTimeout(ok, 500)); }
    assert.ok(clips.length >= 1 && clips[0].title, 'clip produced with metadata'); const c = clips[0];
    assert.equal(c.captionInfo.wordTiming, 'measured'); assert.ok(c.treatments.find((t: any) => t.dimension === 'captions').applied);
    assert.match(c.title, /Cricket Match Ka Sach/); assert.ok(c.tags.includes('cricket')); assert.ok(seen.includes('/audio/transcriptions') && seen.includes('/chat/completions'));
    assert.ok(c.coverage.applied >= 8, `editing features applied: ${c.coverage.applied}`);
  } finally { await app.stop(); await new Promise((ok) => ai.close(ok)); }
});
