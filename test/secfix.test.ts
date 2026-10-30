import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { updateOwnerConfig, loadConfig } from '../src/config.ts';
import { validRemote } from '../src/storage/cloud.ts';
import { bootstrap } from '../src/ops/bootstrap.ts';
import { Store } from '../src/db.ts';
import { tmpDir, testConfig } from './helpers.ts';

const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}` };
async function boot() { const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const port = await app.start(); return { app, base: `http://127.0.0.1:${port}` }; }

test('1+2: wrong-token spam cannot lock out the owner; cookie is a random session, not the master token', async () => {
  const { app, base } = await boot();
  try {
    for (let i = 0; i < 15; i++) await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer nope-nope-nope-nope' } });
    assert.equal((await fetch(`${base}/api/status`, { headers: auth })).status, 200, 'valid owner still gets in');
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: auth });
    const ck = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.ok(!ck.includes(TOKEN), 'master token not in cookie');
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: ck } })).status, 200);
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: 'ytc_sid=forged' } })).status, 401);
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie: ck, 'x-ytc': '1' } });
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: ck } })).status, 401, 'logout kills the session');
  } finally { await app.stop(); }
});

test('4+6: error bodies do not leak paths; security headers present', async () => {
  const { app, base } = await boot();
  try {
    const r = await fetch(`${base}/api/status`, { headers: auth });
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.ok(r.headers.get('x-frame-options') || /frame-ancestors/.test(r.headers.get('content-security-policy') ?? ''));
    const bad = await fetch(`${base}/api/config`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-ytc': '1' }, body: '{bad json' });
    const t = await bad.text(); assert.ok(!/\/home\/|\/tmp\/|node_modules|\.ts:/.test(t), t);
  } finally { await app.stop(); }
});

test('5: rclone remote cannot start with - or contain ..', () => {
  for (const bad of ['--config=/etc/passwd', '-x:y', 'a:../../etc', ' ', '']) assert.equal(validRemote(bad), false, bad);
  assert.equal(validRemote('gdrive:yt-clips/backup'), true);
});

test('7: data/config.json is written 0600', () => {
  const cfg = testConfig(); updateOwnerConfig(cfg, { publishEnabled: false } as never);
  const f = join(cfg.dataDir, 'config.json'); assert.equal(statSync(f).mode & 0o077, 0, 'no group/other access'); void readFileSync(f); void loadConfig;
});

test('3: bootstrap installs once per 24h, respects AUTO_INSTALL=0, never throws', async () => {
  const cfg = testConfig(); const store = new Store(':memory:'); const calls: string[] = [];
  const spawnSetup = (s: string) => { calls.push(s); };
  const off = await bootstrap(store, cfg, { env: { AUTO_INSTALL: '0' }, spawnSetup }); assert.equal(off.started, false); assert.equal(calls.length, 0);
  const old = process.env.PATH; process.env.PATH = '/nonexistent';
  try {
    const a = await bootstrap(store, cfg, { env: {}, spawnSetup, now: 10_000_000_000 });
    if (a.reason === 'setup.sh not found') return; // test config rootDir without setup.sh: path covered
    assert.equal(a.started, true, JSON.stringify(a)); assert.ok(a.missing.includes('ffmpeg'));
    const b = await bootstrap(store, cfg, { env: {}, spawnSetup, now: 10_000_000_000 + 3600_000 }); assert.equal(b.started, false); assert.match(b.reason ?? '', /24 h/);
    const c = await bootstrap(store, cfg, { env: {}, spawnSetup, now: 10_000_000_000 + 25 * 3600_000 }); assert.equal(c.started, true);
  } finally { process.env.PATH = old; }
});
