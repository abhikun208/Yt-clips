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
