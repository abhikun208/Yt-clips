import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { keepAliveTick } from '../src/publish/keepalive.ts';
import { verifyOutputs } from '../src/ops/selfcare.ts';
import { tmpDir } from './helpers.ts';

function fakeApis(state: { ytOk: boolean; ttCalls: number; metaOk: boolean }) {
  return createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url!.startsWith('/token')) return state.ytOk ? send(200, { access_token: 'ya29.x', expires_in: 3600 }) : send(400, { error: 'invalid_grant' });
      if (req.url!.startsWith('/v2/oauth/token')) { state.ttCalls++; return send(200, { access_token: 'tt-new', refresh_token: 'tt-r2', expires_in: 86400 }); }
      if (req.url!.includes('/me?')) return state.metaOk ? send(200, { id: '1' }) : send(400, { error: { code: 190, message: 'Error validating access token' } });
      send(404, {});
    });
  });
}

test('keep-alive: YouTube login is exercised, TikTok token renewed BEFORE it expires, dead logins reported with the exact fix (Testing-mode hint for a fresh YouTube login)', async () => {
  const st = { ytOk: true, ttCalls: 0, metaOk: true }; const srv = fakeApis(st); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  process.env.YT_OAUTH_BASE = base; process.env.TIKTOK_API_BASE = base; process.env.GRAPH_API_BASE = base; process.env.YT_OAUTH_CLIENT_ID = 'cid-1234567890'; process.env.YT_OAUTH_CLIENT_SECRET = 'secret-12345';
  try {
    const d = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir: d }); const store = new Store(join(d, 'k.sqlite')); const sec = SecretStore.forData(cfg.dataDir);
    sec.write('youtube', { refresh_token: 'rt-1', connected_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    sec.write('oauth-app-tiktok', { id: 'ck-123456', secret: 'cs-123456' });
    sec.write('tiktok', { access_token: 'tt-old', refresh_token: 'tt-r1', expires_at: Date.now() + 3600_000, refresh_expires_at: Date.now() + 10 * 86_400_000 });
    sec.write('facebook', { access_token: 'pagetok', page_id: '1' });
    let r = await keepAliveTick(store, cfg);
    assert.equal(r.youtube.main, 'ok'); assert.equal(r.tiktok, 'renewed'); assert.equal(st.ttCalls, 1); assert.equal(r.meta.facebook, 'ok');
    assert.ok(r.alerts.some((a) => /TikTok login \d+ din me expire/.test(a)), 'refresh token expiring within 30 days is announced early');
    st.ytOk = false; st.metaOk = false; process.env.YT_OAUTH_CLIENT_ID = 'cid-other-1234'; // new client id => no cached token trouble; provider cache is per instance anyway
    r = await keepAliveTick(store, cfg);
    assert.equal(r.youtube.main, 'dead'); assert.equal(r.meta.facebook, 'dead');
    assert.ok(r.alerts.some((a) => /Testing.*mode.*Publish app/s.test(a)), 'a login that died 2 days after connecting = OAuth app in Testing mode');
    assert.ok(r.alerts.some((a) => /Facebook login expire/.test(a)));
  } finally { srv.close(); for (const k of ['YT_OAUTH_BASE', 'TIKTOK_API_BASE', 'GRAPH_API_BASE', 'YT_OAUTH_CLIENT_ID', 'YT_OAUTH_CLIENT_SECRET']) delete process.env[k]; }
});

test('crash leftovers: stale *.part.mp4 removed; a corrupt finished clip is deleted and re-queued, a healthy one is untouched', async () => {
  const d = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir: d }); const store = new Store(join(d, 'v.sqlite')); mkdirSync(cfg.dirs.editedShorts, { recursive: true });
  const part = join(cfg.dirs.editedShorts, 'x.part.mp4'); writeFileSync(part, 'half'); const old = new Date(Date.now() - 3 * 3600_000); (await import('node:fs')).utimesSync(part, old, old);
  const bad = join(cfg.dirs.editedShorts, 'bad.mp4'); writeFileSync(bad, Buffer.alloc(20_000, 1));
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1, 'v.mp4', 'vf')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, category, fingerprint) VALUES (1,1,0,9,0.9,'general','fp-v')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, variant, edited_path, state, qc_pass) VALUES (1, 1, 'o1', 0, ?, 'QC_PASSED', 1)`, bad);
  const r = await verifyOutputs(store, cfg); assert.equal(r.parts, 1); assert.deepEqual(r.broken, [1]);
  assert.ok(!existsSync(part) && !existsSync(bad)); assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM jobs WHERE key='render:1' AND state IN ('PENDING','RETRY')`)!.n, 1);
});
