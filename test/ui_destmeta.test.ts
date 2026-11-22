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

test('click-through: per-destination metadata policy (title prefix/suffix + extra tags) is editable in Sources and saved per destination only', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}`, 'content-type': 'application/json' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const ch = await (await fetch(base + '/api/channels', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Second' }) })).json() as { channel: { slug: string } };
    const src = await (await fetch(base + '/api/sources', { method: 'POST', headers: h, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', authorized: true }) })).json() as { id?: number; sourceId?: number };
    const sid = src.id ?? src.sourceId; assert.ok(sid, 'source added');
    assert.equal((await fetch(`${base}/api/sources/${sid}/destinations`, { method: 'POST', headers: h, body: JSON.stringify({ channel: ch.channel.slug }) })).status, 200);
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${T}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(base + '/'); await page.waitForSelector('nav button[data-tab="sources"]'); await page.click('nav button[data-tab="sources"]');
    await page.waitForSelector('[data-smpre]', { timeout: 15000 });
    await page.fill('[data-smpre]', '🔥'); await page.press('[data-smpre]', 'Tab'); await page.waitForTimeout(500);
    await page.fill('[data-smtg]', '#gaming, clips'); await page.press('[data-smtg]', 'Tab'); await page.waitForTimeout(500);
    const r = await (await fetch(`${base}/api/sources/${sid}/destinations`, { headers: h })).json() as { mappings: { metadata: { titlePrefix?: string; titleSuffix?: string; tags?: string[] } }[] };
    assert.equal(r.mappings[0]!.metadata.titlePrefix, '🔥'); assert.deepEqual(r.mappings[0]!.metadata.tags, ['gaming', 'clips']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.stop?.(); }
});
