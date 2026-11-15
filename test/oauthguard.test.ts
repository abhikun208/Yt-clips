import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRedirect, handleOAuthCallback, friendlyOAuthError, resolveBase, toApp } from '../src/publish/oauthguard.ts';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';
import { join } from 'node:path';

test('redirect rules: TikTok needs public https, Meta dashboard rejects http localhost too', () => {
  assert.equal(checkRedirect('tiktok', 'http://127.0.0.1:8787').ok, false);
  assert.equal(checkRedirect('tiktok', 'https://1.2.3.4').ok, false);
  assert.equal(checkRedirect('tiktok', 'https://clips.example.com').ok, true);
  assert.equal(checkRedirect('facebook', 'http://localhost:8787').ok, false); assert.match(checkRedirect('facebook', 'http://127.0.0.1:8080').problems.join(' '), /valid HTTPS/);
  assert.equal(checkRedirect('instagram', 'http://clips.example.com').ok, false);
  assert.match(checkRedirect('facebook', 'https://a.b').badge, /Secure/);
  assert.equal(toApp('instagram'), 'facebook');
});
test('base from env beats request host', () => {
  process.env.OAUTH_PUBLIC_BASE_URL = 'https://x.example.com/';
  assert.equal(resolveBase({ host: 'localhost:1' }), 'https://x.example.com');
  delete process.env.OAUTH_PUBLIC_BASE_URL;
  assert.equal(resolveBase({ proto: 'https', host: 'h.io' }), 'https://h.io');
});
test('callback: provider error, https problem, host mismatch, unknown state are friendly and never throw', async () => {
  const store = new Store(join(tmpDir(), 'o.db')); const cfg = loadConfig(tmpDir());
  const h = handleOAuthCallback('tiktok');
  let r = await h(store, cfg, { error: 'access_denied' }, { host: 'a.com', proto: 'https' }); assert.equal(r.ok, false); assert.match(r.message, /cancel|deny/);
    store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, 'oauth_state_zz', JSON.stringify({ app: 'tiktok', at: Date.now(), ru: 'https://old.com/api/oauth/tiktok/callback' }));
  r = await h(store, cfg, { code: 'c', state: 'zz' }, { host: 'new.com', proto: 'https' }); assert.match(r.message, /doosre par/);
  r = await h(store, cfg, { code: 'c', state: 'nope' }, { host: 'new.com', proto: 'https' }); assert.equal(r.ok, false); assert.match(r.message, /time|purana|Login/);
  assert.match(friendlyOAuthError('redirect_uri mismatch'), /Redirect URI/);
});
test('zero-config base: tunnel headers win over Host, localhost stays http (dev), no .env needed', () => {
  delete process.env.OAUTH_PUBLIC_BASE_URL; delete process.env.PUBLIC_URL;
  assert.equal(resolveBase({ proto: 'https', host: '127.0.0.1:8787', fwdHost: 'abc.trycloudflare.com' }), 'https://abc.trycloudflare.com');
  assert.equal(resolveBase({ proto: 'http', host: 'localhost:8787' }), 'http://localhost:8787');
  assert.equal(checkRedirect('facebook', resolveBase({ proto: 'https', host: 'x', fwdHost: 'abc.trycloudflare.com' })).ok, true);
});

import { parseTunnelUrl } from '../src/ops/tunnel.ts';
test('tunnel url is picked out of cloudflared output', () => { assert.equal(parseTunnelUrl('INF |  https://odd-fox-12.trycloudflare.com  |'), 'https://odd-fox-12.trycloudflare.com'); assert.equal(parseTunnelUrl('nothing here'), null); });

test('tunnel parser ignores cloudflared API host', () => { assert.equal(parseTunnelUrl('Requesting new quick Tunnel on https://api.trycloudflare.com ...'), null); assert.equal(parseTunnelUrl('https://api.trycloudflare.com\n|  https://odd-fox-12.trycloudflare.com |'), 'https://odd-fox-12.trycloudflare.com'); assert.equal(parseTunnelUrl('tunneled with tls termination, https://ab12cd.lhr.life'), 'https://ab12cd.lhr.life'); });
import { lastOAuth } from '../src/publish/oauthguard.ts';
test('last login result is remembered so the dashboard can show why Connect failed', async () => {
  const store = new Store(join(tmpDir(), 'l.db')); const cfg = loadConfig(tmpDir());
  await handleOAuthCallback('facebook')(store, cfg, { error: 'access_denied' }, { host: 'a.com', proto: 'https' });
  const l = lastOAuth(store, 'facebook'); assert.equal(l?.ok, false); assert.match(l!.raw!, /access_denied/);
  assert.match(friendlyOAuthError('oauth: no Facebook Page found for this login'), /Page SELECT/);
});

import { tunnelName } from '../src/ops/tunnel.ts';
test('tunnel name is stable across calls (same https link after restart) and serveo links parse', () => {
  const store = new Store(join(tmpDir(), 't.db')); const a = tunnelName(store); assert.match(a, /^ytc-[0-9a-f]+$/); assert.equal(tunnelName(store), a);
  assert.equal(parseTunnelUrl('Forwarding HTTP traffic from https://ytc-1a2b3c4d.serveo.net'), 'https://ytc-1a2b3c4d.serveo.net');
});
import { setSavedBase, cleanBase } from '../src/publish/oauthguard.ts';
test('owner-saved https base beats tunnel/headers; http or junk is refused', () => {
  delete process.env.OAUTH_PUBLIC_BASE_URL; delete process.env.PUBLIC_URL;
  assert.equal(cleanBase('http://x.com'), null); assert.equal(cleanBase('https://abc.trycloudflare.com/path?x=1'), 'https://abc.trycloudflare.com'); assert.equal(cleanBase('junk'), null); assert.equal(cleanBase('https://localhost'), null);
  setSavedBase('https://my-old.trycloudflare.com'); assert.equal(resolveBase({ proto: 'http', host: '127.0.0.1:8080' }), 'https://my-old.trycloudflare.com'); assert.equal(checkRedirect('facebook', resolveBase({ host: '127.0.0.1:8080' })).ok, true);
  setSavedBase(null); assert.match(resolveBase({ host: '127.0.0.1:8080' }), /^http:/);
});
test('tunnel-provider hosts (api.trycloudflare.com) are refused as the redirect base', () => {
  assert.equal(cleanBase('https://api.trycloudflare.com'), null); assert.equal(cleanBase('https://odd-fox.trycloudflare.com'), 'https://odd-fox.trycloudflare.com');
  assert.equal(checkRedirect('facebook', 'https://api.trycloudflare.com').ok, false); assert.match(checkRedirect('facebook', 'https://api.trycloudflare.com').problems.join(' '), /Method Not Allowed/);
});
import { setRelay, getRelay, redirectUri, startAuth, DEFAULT_RELAY } from '../src/publish/socialOauth.ts';
import { readFileSync } from 'node:fs';
test('relay: one permanent https redirect URI for every app; state carries app+port; relay page only forwards to loopback', () => {
  const store = new Store(join(tmpDir(), 'r.db')); const cfg = loadConfig(tmpDir()); (cfg as any).secrets = undefined;
  setRelay(DEFAULT_RELAY); assert.equal(redirectUri('http://127.0.0.1:8080', 'facebook'), DEFAULT_RELAY); assert.equal(checkRedirect('facebook', 'http://127.0.0.1:8080').ok, true); assert.equal(checkRedirect('tiktok', 'http://127.0.0.1:8080').ok, true);
  const html = readFileSync(new URL('../docs/oauth-relay.html', import.meta.url), 'utf8'); assert.match(html, /127\.0\.0\.1:/); assert.ok(!/location\.(href|replace)\s*=?\s*\(?\s*(q|st)\b/.test(html), 'never redirects to a URL taken from the query');
  assert.match(html, /\(facebook\|tiktok\)\\\.\(\\d\{2,5\}\)/);
  setRelay(null); assert.equal(getRelay(), null); assert.match(redirectUri('http://x.com', 'facebook'), /x\.com\/api\/oauth\/facebook\/callback/);
});
import { saveAppCreds } from '../src/publish/socialOauth.ts';
test('relay start: redirect_uri is the relay and state is <app>.<port>.<hex> (accepted by the relay page regex)', () => {
  const d = tmpDir(); const store = new Store(join(d, 's.db')); const cfg = loadConfig(d); saveAppCreds(cfg, 'facebook', 'APPID1234', 'secretsecret1'); setRelay(DEFAULT_RELAY);
  try { const u = new URL(startAuth(store, cfg, 'facebook', 'http://127.0.0.1:8080', { port: 8080, publish: true })); assert.equal(u.searchParams.get('redirect_uri'), DEFAULT_RELAY); assert.match(u.searchParams.get('state')!, /^facebook\.8080\.[0-9a-f]{8,}$/); } finally { setRelay(null); }
});
import { netFetch } from '../src/publish/socialOauth.ts';
import { createServer } from 'node:net';
test('network failure gives a readable reason, not just "fetch failed"', async () => {
  const port = await new Promise<number>((res) => { const sv = createServer(); sv.listen(0, '127.0.0.1', () => { const p = (sv.address() as { port: number }).port; sv.close(() => res(p)); }); });
  await assert.rejects(netFetch(`http://127.0.0.1:${port}/x`), /network: 127\.0\.0\.1:\d+ tak nahi pahunch paya \(.*ECONNREFUSED/);
  assert.match(friendlyOAuthError('network: graph.facebook.com tak nahi pahunch paya (ENOTFOUND)'), /Private DNS/);
});
