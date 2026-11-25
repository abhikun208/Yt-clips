import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { createChannel, mainChannel } from '../src/channels.ts';
import { tmpDir } from './helpers.ts';

function loadPw(): { chromium: { launch(): Promise<any> } } | null { for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return createRequire(import.meta.url)(p); } catch { /* next */ } } return null; }
const pw = loadPw();

test('click-through: Sources tab -> Upload permission: tick a channel, then choose exclusive; API shows the saved policy', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const T = 'test-token-0123456789'; const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(cfg.dbPath); const main = mainChannel(store); createChannel(store, { name: "Second" }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, authorized, channel_id) VALUES (1,'local','my-video',1,?)`, main.id); store.db.close?.();
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`; const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${T}` }, viewport: { width: 420, height: 900 } }); const page = await ctx.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(base + '/'); await page.waitForSelector('nav button[data-tab="sources"]'); await page.click('nav button[data-tab="sources"]');
    await page.waitForSelector('[data-pd="1"] summary', { timeout: 15000 }); await page.click('[data-pd="1"] summary'); await page.waitForSelector('[data-mp^="1|second"]', { timeout: 10000 });
    await page.check('[data-mp^="1|second"]'); await page.waitForFunction(async () => { const r = await (await fetch('/api/sources/1/upload-policy')).json(); return r.mappings.length === 1; }, null, { timeout: 8000 });
    await page.waitForSelector('[data-mp^="1|second"]:checked'); await page.check('input[name="pm1"][value="own_only"]');
    await page.waitForFunction(async () => (await (await fetch('/api/sources/1/upload-policy')).json()).policy.mode === 'own_only', null, { timeout: 8000 });
    const txt = await page.$eval('[data-pb="1"]', (e: Element) => (e as HTMLElement).innerText); assert.match(txt, /exclusive/); assert.doesNotMatch(txt, /undefined|\[object/); assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.stop?.(); }
});
