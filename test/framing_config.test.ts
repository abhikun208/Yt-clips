import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
test('Smart Framing toggle: default OFF, switchable through /api/config (boolean only), persisted, gates untouched', async () => {
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const get = async () => (await (await fetch(`${base}/api/presets`, { headers: auth })).json() as { framingAdvisor: boolean }).framingAdvisor;
    const post = (b: unknown) => fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify(b) });
    assert.equal(await get(), false, 'default OFF'); assert.equal(app.cfg.edit.framingAdvisor, undefined);
    assert.equal((await post({ framingAdvisor: 'yes' })).status, 400); assert.equal(await get(), false);
    assert.equal((await post({ framingAdvisor: true })).status, 200); assert.equal(await get(), true); assert.equal(app.cfg.edit.framingAdvisor, true);
    assert.equal(JSON.parse(readFileSync(join(app.cfg.dataDir, 'config.json'), 'utf8')).edit.framingAdvisor, true);
    assert.equal((await post({ framingAdvisor: false })).status, 200); assert.equal(await get(), false);
    assert.equal((await post({ gamingProtect: [] })).status, 400, 'protect zones are not exposed through the API');
    assert.deepEqual(app.cfg.gates, { publishEnabled: false, commentsAutoPost: false, publicVisibilityAllowed: false });
    const html = await (await fetch(`${base}/`, { headers: auth })).text(); assert.match(html, /id="sfr"/);
  } finally { await app.stop(); }
});
