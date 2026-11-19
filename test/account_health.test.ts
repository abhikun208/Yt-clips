import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { secretsFor } from '../src/publish/service.ts';
import { createChannel, ytSecretName } from '../src/channels.ts';
import { listDestinations, testDestination } from '../src/accounts/destinations.ts';
import { tmpDir } from './helpers.ts';

test('a revoked token is shown as expired (not connected); Test Connection reports honestly and a working login recovers', async () => {
  let revoked = true; const srv = createServer((req, res) => { res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/token')) { req.resume(); return void (revoked ? (res.statusCode = 400, res.end(JSON.stringify({ error: 'unauthorized_client' }))) : res.end(JSON.stringify({ access_token: 'A', expires_in: 3600 }))); }
    if (req.url?.startsWith('/youtube/v3/channels')) return void res.end(JSON.stringify({ items: [{ id: 'UC_A', snippet: { title: 'Chan A' } }] }));
    res.statusCode = 404; res.end('{}'); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok)); const port = (srv.address() as { port: number }).port; const old = { ...process.env };
  Object.assign(process.env, { YT_API_BASE: `http://127.0.0.1:${port}`, YT_OAUTH_BASE: `http://127.0.0.1:${port}`, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() }); const a = createChannel(store, { name: 'Chan A' }, () => true);
    secretsFor(cfg).write(ytSecretName(a), { refresh_token: 'RT' }); store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, `ytinfo:${a.slug}`, JSON.stringify({ channelId: 'UC_A', title: 'Chan A', at: 'x' }));
    assert.equal(listDestinations(store, cfg).find((d) => d.id === 'yt:UC_A')?.status, 'connected', 'before any check it is only as good as the stored evidence');
    const t1 = await testDestination(store, cfg, 'yt:UC_A'); assert.equal(t1.ok, false); assert.equal(t1.status, 'expired');
    assert.equal(listDestinations(store, cfg).find((d) => d.id === 'yt:UC_A')?.status, 'expired');
    revoked = false; const t2 = await testDestination(store, cfg, 'yt:UC_A'); assert.equal(t2.ok, true, t2.message);
    assert.equal(listDestinations(store, cfg).find((d) => d.id === 'yt:UC_A')?.status, 'connected');
    store.exec(`UPDATE kv SET v=? WHERE k=?`, JSON.stringify({ channelId: 'UC_OTHER', title: 'x', at: 'x' }), `ytinfo:${a.slug}`); const t3 = await testDestination(store, cfg, 'yt:UC_OTHER'); assert.equal(t3.status, 'mismatch');
  } finally { srv.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
