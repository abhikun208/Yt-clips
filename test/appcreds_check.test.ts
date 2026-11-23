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
