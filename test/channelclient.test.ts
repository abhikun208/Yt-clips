import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../src/publish/secrets.ts';
import { loginClient, TokenProvider } from '../src/publish/oauth.ts';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createServer } from 'node:http';

test('per-channel client override wins for login; token pins the client that minted it for refresh', async () => {
  const sec = SecretStore.forData(mkdtempSync(join(tmpdir(), 'ytc-')));
  sec.write('youtube-client', { client_id: 'GLOBAL-client-id-123456', client_secret: 'globalsecret1' });
  assert.equal(loginClient(sec, 'youtube-b')?.clientId, 'GLOBAL-client-id-123456');
  sec.write('youtube-b-client', { client_id: 'OWN-client-id-1234567', client_secret: 'ownsecret123' });
  assert.equal(loginClient(sec, 'youtube-b')?.clientId, 'OWN-client-id-1234567');
  assert.equal(loginClient(sec, 'youtube')?.clientId, 'GLOBAL-client-id-123456', 'other channels unaffected');
  const seen: string[] = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => b += d); req.on('end', () => { seen.push(new URLSearchParams(b).get('client_id') ?? ''); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'x', expires_in: 3600 })); }); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok)); const port = (srv.address() as { port: number }).port;
  process.env.YT_OAUTH_BASE = `http://127.0.0.1:${port}`;
  try {
    // token minted by an OLD client; global client has since changed -> must still refresh with the old one
    sec.write('youtube', { refresh_token: 'rt', client_id: 'OLD-client-id-123456789', client_secret: 'oldsecret123' });
    await new TokenProvider(sec, 'youtube').accessToken();
    assert.equal(seen[0], 'OLD-client-id-123456789');
  } finally { srv.close(); delete process.env.YT_OAUTH_BASE; }
});
