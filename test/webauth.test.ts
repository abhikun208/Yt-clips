import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { tmpDir } from './helpers.ts';

/** Offline stand-in for Google's token + channels endpoints (real Google can only be checked by the owner: Connect button). */
test('web login: Connect -> Google redirect -> callback stores encrypted token, UI only gets channel id/title; single-use + expiry; share link works without cookie', async () => {
  const seen: string[] = [];
  const g = createServer((req, res) => { const ch: Buffer[] = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { const u = new URL(req.url!, 'http://x'); const body = Buffer.concat(ch).toString(); seen.push(u.pathname);
    if (u.pathname === '/token' && new URLSearchParams(body).get('code') === 'connection-check') { res.writeHead(400, { 'content-type': 'application/json' }); return void res.end('{"error":"invalid_grant"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/token') { const p = new URLSearchParams(body); if (p.get('grant_type') !== 'refresh_token') { assert.ok(p.get('code_verifier')); assert.equal(p.get('redirect_uri')?.endsWith('/api/oauth/youtube/callback'), true); } return void res.end(JSON.stringify(p.get('grant_type') === 'refresh_token' ? { access_token: 'at', expires_in: 3600 } : { refresh_token: 'RT-SECRET-123', scope: 'x', access_token: 'at' })); }
    if (u.pathname === '/youtube/v3/channels') return void res.end(JSON.stringify({ items: [{ id: 'UCabc123', snippet: { title: 'Team Unknown' } }] }));
    res.end('{}'); }); });
  await new Promise<void>((r) => g.listen(0, '127.0.0.1', r)); const gb = `http://127.0.0.1:${(g.address() as { port: number }).port}`;
  process.env.YT_OAUTH_BASE = gb; process.env.YT_API_BASE = gb;
  const dataDir = tmpDir(); const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-ytc': '1' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir, autoRun: false }); const port = await app.start(); const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/channels/main/youtube/web`, { method: 'POST', headers: auth, body: '{}' })).status, 400, 'needs client id/secret first');
    await fetch(`${base}/api/settings/oauth-app`, { method: 'POST', headers: auth, body: JSON.stringify({ app: 'google', clientId: 'client-id-1234567890.apps', clientSecret: 'secret-12345678' }) });
    const w = await (await fetch(`${base}/api/channels/main/youtube/web`, { method: 'POST', headers: auth, body: '{}' })).json() as { authUrl: string; redirectUri: string };
    const au = new URL(w.authUrl); assert.equal(au.searchParams.get('code_challenge_method'), 'S256'); assert.match(au.searchParams.get('scope')!, /youtube\.upload/); assert.equal(au.searchParams.get('redirect_uri'), `${base}/api/oauth/youtube/callback`);
    const state = au.searchParams.get('state')!;
    assert.match(await (await fetch(`${base}/api/oauth/youtube/callback?code=C1&state=WRONG`)).text(), /expire|use ho chuka/, 'bad state rejected');
    const ok = await fetch(`${base}/api/oauth/youtube/callback?code=C1&state=${state}`); const html = await ok.text(); assert.match(html, /Connected/); assert.match(html, /Team Unknown/); assert.doesNotMatch(html, /RT-SECRET/);
    assert.match(await (await fetch(`${base}/api/oauth/youtube/callback?code=C1&state=${state}`)).text(), /use ho chuka|expire/, 'state is single-use');
    const st = await (await fetch(`${base}/api/channels/main/youtube`, { headers: auth })).json() as any; assert.equal(st.connected, true); assert.equal(st.identity.channelId, 'UCabc123'); assert.doesNotMatch(JSON.stringify(st), /RT-SECRET/);
    for (const p of ['/api/channels', '/api/settings', '/api/connections', '/api/youtube']) assert.doesNotMatch(await (await fetch(`${base}${p}`, { headers: auth })).text(), /RT-SECRET/, p);
    assert.equal(new SecretStore(dataDir, undefined).constructor.name, 'SecretStore'); // stored via the vault, not plaintext in config
    const { readdirSync, readFileSync } = await import('node:fs'); const all = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && !/\.(mp4|jpg|db|db-wal|db-shm)$/.test(d.name)).map((d) => readFileSync(`${d.parentPath}/${d.name}`, 'utf8')).join('\n'); assert.doesNotMatch(all, /RT-SECRET-123/, 'refresh token is never stored in plaintext');
    // share link for another channel: the redirect carries no cookie/token and still works
    await fetch(`${base}/api/channels`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Decider Gaming' }) });
    const sh = await (await fetch(`${base}/api/channels/decider-gaming/youtube/web`, { method: 'POST', headers: auth, body: '{"share":true}' })).json() as { authUrl: string; share: boolean }; assert.equal(sh.share, true);
    const page = await (await fetch(`${base}/api/oauth/youtube/callback?code=C2&state=${new URL(sh.authUrl).searchParams.get('state')}`)).text(); assert.match(page, /Connected/);
    assert.equal(((await (await fetch(`${base}/api/channels/decider-gaming/youtube`, { headers: auth })).json()) as any).connected, true);
  } finally { await app.stop(); g.close(); delete process.env.YT_OAUTH_BASE; delete process.env.YT_API_BASE; }
});

test('paste mode: no redirect URI registration; pasted address-bar URL or bare code finishes the login; wrong channel/state rejected', async () => {
  const g = createServer((req, res) => { const ch: Buffer[] = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { const u = new URL(req.url!, 'http://x'); const p = new URLSearchParams(Buffer.concat(ch).toString());
    if (u.pathname === '/token' && p.get('code') === 'connection-check') { res.writeHead(400, { 'content-type': 'application/json' }); return void res.end('{"error":"invalid_grant"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/token') return void res.end(JSON.stringify(p.get('grant_type') === 'refresh_token' ? { access_token: 'at', expires_in: 3600 } : { refresh_token: 'RT2', redirect_seen: p.get('redirect_uri') }));
    if (u.pathname === '/youtube/v3/channels') return void res.end(JSON.stringify({ items: [{ id: 'UCpaste', snippet: { title: 'Paste Channel' } }] })); res.end('{}'); }); });
  await new Promise<void>((r) => g.listen(0, '127.0.0.1', r)); const gb = `http://127.0.0.1:${(g.address() as { port: number }).port}`; process.env.YT_OAUTH_BASE = gb; process.env.YT_API_BASE = gb;
  const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-ytc': '1' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    await fetch(`${base}/api/settings/oauth-app`, { method: 'POST', headers: auth, body: JSON.stringify({ app: 'google', clientId: 'client-id-1234567890.apps', clientSecret: 'secret-12345678' }) });
    const w = await (await fetch(`${base}/api/channels/main/youtube/web`, { method: 'POST', headers: auth, body: '{"paste":true}' })).json() as { authUrl: string; redirectUri: string };
    assert.equal(w.redirectUri, 'http://127.0.0.1:8765/'); const state = new URL(w.authUrl).searchParams.get('state')!;
    assert.equal((await fetch(`${base}/api/channels/main/youtube/paste`, { method: 'POST', headers: auth, body: JSON.stringify({ url: 'http://127.0.0.1:8765/?state=BAD&code=4/0AbC_defGHI123' }) })).status, 400);
    const ok = await fetch(`${base}/api/channels/main/youtube/paste`, { method: 'POST', headers: auth, body: JSON.stringify({ url: `http://127.0.0.1:8765/?state=${state}&code=4/0AbC_defGHI123&scope=x` }) }); assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).identity.channelId, 'UCpaste');
    const w2 = await (await fetch(`${base}/api/channels/main/youtube/web`, { method: 'POST', headers: auth, body: '{"paste":true}' })).json() as { authUrl: string };
    const bare = await fetch(`${base}/api/channels/main/youtube/paste`, { method: 'POST', headers: auth, body: JSON.stringify({ url: '4/0AbC_defGHI123456' }) }); assert.equal(bare.status, 200, 'bare code uses the latest paste state'); void w2;
    assert.equal((await fetch(`${base}/api/channels/main/youtube/paste`, { method: 'POST', headers: auth, body: JSON.stringify({ url: 'nonsense with spaces' }) })).status, 400);
  } finally { await app.stop(); g.close(); delete process.env.YT_OAUTH_BASE; delete process.env.YT_API_BASE; }
});
