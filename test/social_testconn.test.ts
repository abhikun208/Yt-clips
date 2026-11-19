import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { testDestination, listDestinations } from '../src/accounts/destinations.ts';
import { tmpDir } from './helpers.ts';

test('Test Connection for Facebook/TikTok against fake servers: connected, mismatch, expired', async () => {
  let mode: 'ok' | 'wrong' | 'dead' = 'ok';
  const srv = http.createServer((q, s) => {
    s.setHeader('content-type', 'application/json');
    if (mode === 'dead') { s.statusCode = 401; return void s.end(JSON.stringify({ error: { code: 190, message: 'expired' } })); }
    if (q.url!.startsWith('/v2/user/info')) return void s.end(JSON.stringify({ data: { user: { open_id: mode === 'wrong' ? 'OTHER' : 'T1', display_name: 'TT' } } }));
    s.end(JSON.stringify({ id: mode === 'wrong' ? 'P999' : 'P1', name: 'My Page' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  process.env.GRAPH_API_BASE = base; process.env.TIKTOK_API_BASE = base;
  try {
    const dir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir: dir }); const st = new Store(cfg.dbPath); const sec = SecretStore.forData(cfg.dataDir);
    sec.write('facebook', { page_id: 'P1', page_name: 'My Page', access_token: 'FB' }); sec.write('tiktok', { open_id: 'T1', access_token: 'TK', display_name: 'TT' });
    listDestinations(st, cfg);
    for (const id of ['fb:P1', 'tt:T1']) {
      mode = 'ok'; let r = await testDestination(st, cfg, id); assert.equal(r.status, 'connected', id); assert.ok(listDestinations(st, cfg).find((d) => d.id === id)!.verifiedAt);
      mode = 'wrong'; r = await testDestination(st, cfg, id); assert.equal(r.status, 'mismatch', id);
      mode = 'dead'; r = await testDestination(st, cfg, id); assert.equal(r.status, 'expired', id); assert.equal(listDestinations(st, cfg).find((d) => d.id === id)!.status, 'expired');
      mode = 'ok'; r = await testDestination(st, cfg, id); assert.equal(r.ok, true); assert.equal(listDestinations(st, cfg).find((d) => d.id === id)!.status, 'connected');
    }
  } finally { srv.close(); delete process.env.GRAPH_API_BASE; delete process.env.TIKTOK_API_BASE; }
});
