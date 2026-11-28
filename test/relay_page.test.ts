import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

test('app serves the login relay page itself (no auth) and /api/oauth/relay/check reports a dead relay with a fix', { timeout: 60_000 }, async () => {
  const d = tmpDir(); const app = createApp({ host: '127.0.0.1', dataDir: d, rootDir: d, port: 0, token: 'tok-1234567890abcdef' } as never); const port = await app.start();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/oauth-relay.html`); const t = await r.text(); assert.equal(r.status, 200); assert.match(t, /yt-clips login relay/); assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const dead = createServer((_q, s) => { s.statusCode = 404; s.end('There isn\'t a GitHub Pages site here.'); }); await new Promise<void>((ok) => dead.listen(0, '127.0.0.1', ok)); const dp = (dead.address() as { port: number }).port;
    const H = { authorization: 'Bearer tok-1234567890abcdef', 'content-type': 'application/json' };
    const c = await (await fetch(`http://127.0.0.1:${port}/api/oauth/relay/check?url=${encodeURIComponent(`http://127.0.0.1:${dp}/x.html`)}`, { headers: H })).json() as { ok: boolean; status: number; fix: string };
    assert.equal(c.ok, false); assert.equal(c.status, 404); assert.match(c.fix, /GitHub Actions|Pages/); dead.closeAllConnections(); dead.close();
    const g = await (await fetch(`http://127.0.0.1:${port}/api/oauth/relay/check?url=${encodeURIComponent(`http://127.0.0.1:${port}/oauth-relay.html`)}`, { headers: H })).json() as { ok: boolean }; assert.equal(g.ok, true);
  } finally { await app.stop?.(); }
});
