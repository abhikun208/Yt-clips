import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

function loadPw(): { chromium: { launch(): Promise<any> } } | null {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return createRequire(import.meta.url)(p); } catch { /* next */ } }
  return null;
}
const pw = loadPw();

test('click-through: Live card in Sources shows status + buffer, Live Priority and per-source Watch toggles call the real APIs', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}`, 'content-type': 'application/json' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const add = await fetch(base + '/api/sources', { method: 'POST', headers: h, body: JSON.stringify({ url: 'https://www.youtube.com/@ishowspeed', authorized: true }) }); assert.ok(add.ok, 'source added');
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${T}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    const calls: string[] = []; page.on('request', (r: { url(): string; method(): string }) => { if (r.method() === 'POST') calls.push(new URL(r.url()).pathname); });
    await page.goto(base + '/'); await page.waitForSelector('nav button[data-tab="sources"]'); await page.click('nav button[data-tab="sources"]');
    await page.waitForSelector('#livebody [data-live]', { timeout: 15000 });
    const txt: string = await page.$eval('#livecard', (e: Element) => (e as HTMLElement).innerText); assert.match(txt, /Live Priority Mode/); assert.match(txt, /Rolling buffer/); assert.match(txt, /ishowspeed/i);
    await page.click('#liveprio'); await page.waitForTimeout(500);
    assert.ok(calls.includes('/api/live/priority')); assert.equal((await (await fetch(base + '/api/live', { headers: h })).json() as { priority: boolean }).priority, false);
    await page.click('#livebody [data-live]'); await page.waitForTimeout(600);
    assert.ok(calls.some((c) => /^\/api\/sources\/\d+\/live$/.test(c)));
    const st = await (await fetch(base + '/api/live', { headers: h })).json() as { sources: { watch: boolean }[] }; assert.equal(st.sources[0]!.watch, true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.stop?.(); }
});
