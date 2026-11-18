import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

test('accounts API with the exact URL the browser sends (encoded "yt%3A…"): disable/disconnect work, dedupe keeps one', async () => {
  const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }; const dir = tmpDir();
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: dir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const post = (p: string, b: unknown = {}) => fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(b) });
    await post('/api/channels', { name: 'Decider Gaming' }); await post('/api/channels', { name: 'Decider Gamming' });
    const cfg = loadConfig(process.cwd(), { dataDir: dir }); const sec = SecretStore.forData(cfg.dataDir); const st = new Store(cfg.dbPath);
    for (const [s, n] of [['youtube-decider-gaming', 'decider-gaming'], ['youtube-decider-gamming', 'decider-gamming'], ['youtube', 'main']] as const) { sec.write(s, { refresh_token: 'R' + n }); st.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `ytinfo:${n}`, JSON.stringify({ channelId: n === 'main' ? 'UC_MAIN' : 'UC_DECIDER', title: n, at: 'x' })); }
    const list = async () => (await (await fetch(base + '/api/accounts', { headers: auth })).json() as { accounts: { id: string; status: string; enabled: boolean; warnings: string[] }[] }).accounts;
    let a = await list(); const dec = a.find((x) => x.id === 'yt:UC_DECIDER')!; assert.ok(dec.warnings.length, 'duplicate flagged');
    assert.equal((await post(`/api/accounts/${encodeURIComponent('yt:UC_DECIDER')}/disable`)).status, 200);
    assert.equal((await list()).find((x) => x.id === 'yt:UC_DECIDER')!.enabled, false);
    assert.equal((await post(`/api/accounts/${encodeURIComponent('yt:UC_DECIDER')}/dedupe`)).status, 200);
    a = await list(); assert.equal(a.find((x) => x.id === 'yt:UC_DECIDER')!.warnings.length, 0); assert.equal(a.find((x) => x.id === 'yt:UC_DECIDER')!.status, 'connected');
    assert.equal((await post(`/api/accounts/${encodeURIComponent('yt:UC_DECIDER')}/disconnect`)).status, 200);
    a = await list(); assert.equal(a.find((x) => x.id === 'yt:UC_DECIDER')!.status, 'disconnected'); assert.equal(a.find((x) => x.id === 'yt:UC_MAIN')!.status, 'connected');
    assert.equal((await post(`/api/accounts/${encodeURIComponent('yt:UC_DECIDER')}/disconnect`)).status, 200, 'repeat disconnect is idempotent');
  } finally { await app.stop?.(); }
});
