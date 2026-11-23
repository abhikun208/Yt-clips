import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.ts';
import { saveAppCreds, checkAppCreds } from '../src/publish/socialOauth.ts';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

async function fakeMeta(good: { id: string; secret: string }) {
  const s = createServer((req, res) => { const u = new URL(req.url!, 'http://x'); res.setHeader('content-type', 'application/json');
    if (u.pathname.endsWith('/oauth/access_token')) { const ok = u.searchParams.get('client_id') === good.id && u.searchParams.get('client_secret') === good.secret; res.statusCode = ok ? 200 : 400; return void res.end(JSON.stringify(ok ? { access_token: 'APPTOKEN' } : { error: { message: 'Error validating client secret.' } })); }
    if (u.pathname.endsWith('/' + good.id)) return void res.end(JSON.stringify({ name: 'Api1i' })); res.statusCode = 500; res.end('{}'); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return { s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
}
test('checkAppCreds: right pair => ok + app name; wrong secret => bad; Meta unreachable/odd answer => unknown (never blocks); secret never in output', async () => {
  const g = await fakeMeta({ id: 'app-12345', secret: 'right-secret-1' }); process.env.GRAPH_API_BASE = g.base;
  try {
    const cfg = loadConfig(tmpDir()); assert.equal((await checkAppCreds(cfg, 'facebook')).status, 'unknown'); // nothing saved
    saveAppCreds(cfg, 'facebook', 'app-12345', 'right-secret-1'); const ok = await checkAppCreds(cfg, 'facebook'); assert.equal(ok.status, 'ok'); assert.equal(ok.appName, 'Api1i');
    saveAppCreds(cfg, 'facebook', 'app-12345', 'WRONG-secret-1'); const bad = await checkAppCreds(cfg, 'facebook'); assert.equal(bad.status, 'bad'); assert.ok(!JSON.stringify(bad).includes('WRONG-secret-1'));
    process.env.GRAPH_API_BASE = 'http://127.0.0.1:1'; assert.equal((await checkAppCreds(cfg, 'facebook')).status, 'unknown');
    assert.equal((await checkAppCreds(cfg, 'tiktok')).status, 'unknown');
  } finally { g.s.close(); delete process.env.GRAPH_API_BASE; }
});
test('API (real HTTP): Connect with a bad App secret is stopped BEFORE the Facebook trip with a clear message; good pair gives the login URL', async () => {
  const g = await fakeMeta({ id: 'app-12345', secret: 'right-secret-1' }); process.env.GRAPH_API_BASE = g.base;
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}` }; const dir = tmpDir(); const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: dir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const save = (secret: string) => fetch(base + '/api/settings/oauth-app', { method: 'POST', headers: h, body: JSON.stringify({ app: 'facebook', clientId: 'app-12345', clientSecret: secret }) });
    const s1 = await (await save('WRONG-secret-1')).json() as { creds: { status: string } }; assert.equal(s1.creds.status, 'bad');
    const r1 = await fetch(base + '/api/oauth/facebook/start', { headers: h }); assert.equal(r1.status, 400); const e1 = await r1.json() as { error: string }; assert.match(e1.error, /App ID\/Secret/); assert.ok(!e1.error.includes('WRONG-secret-1'));
    const s2 = await (await save('right-secret-1')).json() as { creds: { status: string; appName?: string } }; assert.equal(s2.creds.status, 'ok'); assert.equal(s2.creds.appName, 'Api1i');
    const r2 = await fetch(base + '/api/oauth/facebook/start', { headers: h }); assert.equal(r2.status, 200); assert.match(((await r2.json()) as { authUrl: string }).authUrl, /dialog\/oauth.*client_id=app-12345/);
    const c = await (await fetch(base + '/api/oauth/facebook/check', { headers: h })).json() as { status: string }; assert.equal(c.status, 'ok');
  } finally { await app.stop(); g.s.close(); delete process.env.GRAPH_API_BASE; }
});
import { Store } from '../src/db.ts';
import { startAuth, setFbConfigId, getFbConfigId } from '../src/publish/socialOauth.ts';
import { friendlyOAuthError } from '../src/publish/oauthguard.ts';
test('Facebook Login for Business: with a Configuration ID the dialog uses config_id (no scope); without it the old scope dialog is unchanged; bad id rejected', () => {
  const cfg = loadConfig(tmpDir()); const store = new Store(':memory:'); saveAppCreds(cfg, 'facebook', 'app-12345', 'right-secret-1');
  const u0 = new URL(startAuth(store, cfg, 'facebook', 'https://x.example')); assert.ok(u0.searchParams.get('scope')); assert.equal(u0.searchParams.get('config_id'), null);
  assert.throws(() => setFbConfigId(store, 'abc')); setFbConfigId(store, ' 1821 2805 95589485 '); assert.equal(getFbConfigId(store), '1821280595589485');
  const u1 = new URL(startAuth(store, cfg, 'facebook', 'https://x.example')); assert.equal(u1.searchParams.get('config_id'), '1821280595589485'); assert.equal(u1.searchParams.get('scope'), null); assert.equal(u1.searchParams.get('response_type'), 'code');
  setFbConfigId(store, ''); assert.equal(getFbConfigId(store), null); assert.ok(new URL(startAuth(store, cfg, 'facebook', 'https://x.example')).searchParams.get('scope'));
});
test('empty Pages: message says Pages permission was not granted and points to the Configuration ID; with pages_show_list granted it keeps the select-your-Page hint', () => {
  const a = friendlyOAuthError('oauth: no Facebook Page found for this login (granted permissions: public_profile)'); assert.match(a, /Configuration ID/); assert.match(a, /public_profile/);
  const b = friendlyOAuthError('oauth: no Facebook Page found for this login (granted permissions: pages_show_list,instagram_basic)'); assert.ok(!/Configuration ID/.test(b)); assert.match(b, /SELECT/);
});
import { handleCallback } from '../src/publish/socialOauth.ts';
import { SecretStore } from '../src/publish/secrets.ts';
test('empty /me/accounts (Business-portfolio Page): the ticked Page is read from debug_token granular scopes and connected; nothing ticked => clear error', async () => {
  const mk = async (targets: string[]) => createServer((req, res) => { const u = new URL(req.url!, 'http://x'); res.setHeader('content-type', 'application/json'); const p = u.pathname;
    if (p.endsWith('/oauth/access_token')) return void res.end(JSON.stringify({ access_token: 'U1' }));
    if (p.endsWith('/me/accounts')) return void res.end(JSON.stringify({ data: [] }));
    if (p.endsWith('/me/permissions')) return void res.end(JSON.stringify({ data: [{ permission: 'pages_show_list', status: 'granted' }] }));
    if (p.endsWith('/debug_token')) return void res.end(JSON.stringify({ data: { granular_scopes: [{ scope: 'pages_show_list', target_ids: targets }, { scope: 'ads_read', target_ids: ['999999'] }] } }));
    if (p.endsWith('/777777')) return void res.end(JSON.stringify({ id: '777777', name: 'My Page', access_token: 'PT', instagram_business_account: { id: '555555' } }));
    res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'nope' } })); });
  for (const [targets, expectOk] of [[['777777'], true], [[], false]] as const) {
    const s = await mk([...targets]); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); process.env.GRAPH_API_BASE = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    try {
      const cfg = loadConfig(tmpDir()); const store = new Store(':memory:'); saveAppCreds(cfg, 'facebook', 'app-12345', 'right-secret-1'); const st = new URL(startAuth(store, cfg, 'facebook', 'https://x.example')).searchParams.get('state')!;
      if (expectOk) { const r = await handleCallback(store, cfg, 'facebook', { code: 'c', state: st }, 'https://x.example'); assert.ok(r.connected.includes('facebook')); const pages = SecretStore.forData(cfg.dataDir).read<{ pages: { id: string; ig_user_id: string | null }[] }>('meta-pages')!.pages; assert.deepEqual(pages.map((p) => [p.id, p.ig_user_id]), [['777777', '555555']]); }
      else await assert.rejects(() => handleCallback(store, cfg, 'facebook', { code: 'c', state: st }, 'https://x.example'), /no Facebook Page found/);
    } finally { s.close(); delete process.env.GRAPH_API_BASE; }
  }
});
test('empty Pages: the error carries Meta\'s own answers (calls, counts, errors) but never a token or the secret', async () => {
  const s = createServer((req, res) => { const u = new URL(req.url!, 'http://x'); res.setHeader('content-type', 'application/json'); const p = u.pathname;
    if (p.endsWith('/oauth/access_token')) return void res.end(JSON.stringify({ access_token: 'SECRETUSERTOKEN' }));
    if (p.endsWith('/me/accounts')) return void res.end(JSON.stringify({ data: [] }));
    if (p.endsWith('/me/permissions')) return void res.end(JSON.stringify({ data: [{ permission: 'pages_show_list', status: 'granted' }] }));
    if (p.endsWith('/debug_token')) return void res.end(JSON.stringify({ data: { type: 'USER', is_valid: true, granular_scopes: [{ scope: 'pages_show_list' }] } }));
    if (p.endsWith('/me/businesses')) { res.statusCode = 400; return void res.end(JSON.stringify({ error: { message: '(#200) Requires business_management permission' } })); }
    if (p.endsWith('/me')) return void res.end(JSON.stringify({ id: '1', name: 'X' }));
    res.statusCode = 400; res.end('{}'); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); process.env.GRAPH_API_BASE = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    const cfg = loadConfig(tmpDir()); const store = new Store(':memory:'); saveAppCreds(cfg, 'facebook', 'app-12345', 'right-secret-1'); const st = new URL(startAuth(store, cfg, 'facebook', 'https://x.example')).searchParams.get('state')!;
    const err = await handleCallback(store, cfg, 'facebook', { code: 'c', state: st }, 'https://x.example').then(() => '', (e: Error) => e.message);
    assert.match(err, /me\/accounts=0 items/); assert.match(err, /token=USER valid=true scopes=\[pages_show_list:0\]/); assert.match(err, /businesses=ERR\(.*business_management/); assert.ok(!err.includes('SECRETUSERTOKEN') && !err.includes('right-secret-1'));
    const msg = friendlyOAuthError(err); assert.match(msg, /Meta ka jawab: me=ok; me\/accounts=0 items/); assert.ok(!msg.includes('SECRETUSERTOKEN'));
  } finally { s.close(); delete process.env.GRAPH_API_BASE; }
});
test('Business-portfolio Pages: /me/accounts empty but /me/businesses -> owned_pages has the Page => connected; scope now asks business_management; the business hint shows when that permission is missing', async () => {
  assert.match(new URL(startAuth(new Store(':memory:'), (() => { const c = loadConfig(tmpDir()); saveAppCreds(c, 'facebook', 'app-12345', 'right-secret-1'); return c; })(), 'facebook', 'https://x.example')).searchParams.get('scope')!, /business_management/);
  const s = createServer((req, res) => { const u = new URL(req.url!, 'http://x'); res.setHeader('content-type', 'application/json'); const p = u.pathname;
    if (p.endsWith('/oauth/access_token')) return void res.end(JSON.stringify({ access_token: 'U1' }));
    if (p.endsWith('/me/accounts')) return void res.end(JSON.stringify({ data: [] }));
    if (p.endsWith('/me/permissions')) return void res.end(JSON.stringify({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'business_management', status: 'granted' }] }));
    if (p.endsWith('/debug_token')) return void res.end(JSON.stringify({ data: { granular_scopes: [] } }));
    if (p.endsWith('/me/businesses')) return void res.end(JSON.stringify({ data: [{ id: 'B1' }] }));
    if (p.endsWith('/B1/owned_pages')) return void res.end(JSON.stringify({ data: [{ id: '777777', name: 'Team Unknown 1M', access_token: 'PT', instagram_business_account: { id: '555555' } }] }));
    if (p.endsWith('/B1/client_pages')) { res.statusCode = 400; return void res.end(JSON.stringify({ error: { message: 'nope' } })); }
    res.statusCode = 400; res.end('{}'); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); process.env.GRAPH_API_BASE = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    const cfg = loadConfig(tmpDir()); const store = new Store(':memory:'); saveAppCreds(cfg, 'facebook', 'app-12345', 'right-secret-1'); const st = new URL(startAuth(store, cfg, 'facebook', 'https://x.example')).searchParams.get('state')!;
    const r = await handleCallback(store, cfg, 'facebook', { code: 'c', state: st }, 'https://x.example'); assert.ok(r.connected.includes('facebook'));
    assert.deepEqual(SecretStore.forData(cfg.dataDir).read<{ pages: { id: string; ig_user_id: string | null }[] }>('meta-pages')!.pages.map((p) => [p.id, p.ig_user_id]), [['777777', '555555']]);
  } finally { s.close(); delete process.env.GRAPH_API_BASE; }
  const hint = friendlyOAuthError('oauth: no Facebook Page found for this login (granted permissions: pages_show_list,public_profile; assets ticked in dialog: 0; meta says: me=ok; me/accounts=0 items; token=USER valid=true scopes=[pages_show_list:0]; businesses=ERR((#100) Missing Permission))');
  assert.match(hint, /Business portfolio/); assert.match(hint, /business_management/);
});
