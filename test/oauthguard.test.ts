import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRedirect, handleOAuthCallback, friendlyOAuthError, resolveBase, toApp } from '../src/publish/oauthguard.ts';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';
import { join } from 'node:path';

test('redirect rules: TikTok needs public https, Meta allows localhost http', () => {
  assert.equal(checkRedirect('tiktok', 'http://127.0.0.1:8787').ok, false);
  assert.equal(checkRedirect('tiktok', 'https://1.2.3.4').ok, false);
  assert.equal(checkRedirect('tiktok', 'https://clips.example.com').ok, true);
  assert.equal(checkRedirect('facebook', 'http://localhost:8787').ok, true);
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
  r = await h(store, cfg, { code: 'c', state: 's' }, { host: '127.0.0.1:8787' }); assert.match(r.message, /HTTPS/);
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
