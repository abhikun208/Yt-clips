import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

// Clicks EVERY visible, enabled button of every tab in real Chromium (empty DB, fake-free: nothing leaves the machine except calls that fail fast).
// Fails on any JS error, unhandled rejection or HTTP 5xx from /api. 4xx (e.g. "connect first") are legitimate answers and are tallied only.
function loadPw(): { chromium: { launch(): Promise<any> } } | null {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return createRequire(import.meta.url)(p); } catch { /* next */ } }
  return null;
}
const pw = loadPw();

test('click-through: every visible button on every tab runs without JS errors or API 5xx', { skip: pw ? false : 'playwright not installed', timeout: 600_000 }, async () => {
  const TOKEN = 'test-token-0123456789'; const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  const browser = await pw!.chromium.launch(); const errors: string[] = []; let clicked = 0; const fourxx = new Map<string, number>();
  try {
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage(); let current = 'load';
    page.on('dialog', (d: { dismiss(): Promise<void> }) => { void d.dismiss(); });
    page.on('pageerror', (e: Error) => errors.push(`[${current}] pageerror: ${e.message}`));
    page.on('response', (r: { url(): string; status(): number; request(): { method(): string } }) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/api/')) return; if (r.status() >= 500) errors.push(`[${current}] ${r.request().method()} ${u.pathname} -> ${r.status()}`); else if (r.status() >= 400) fourxx.set(u.pathname, (fourxx.get(u.pathname) ?? 0) + 1); });
    await page.goto(base + '/'); await page.waitForSelector('nav button[data-tab="home"]', { timeout: 15000 });
    const tabs: string[] = await page.$$eval('nav button[data-tab]', (b: Element[]) => b.map((x) => (x as HTMLElement).dataset.tab!));
    for (const t of tabs) {
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => (d as HTMLDialogElement).close())); await page.click(`nav button[data-tab="${t}"]`, { timeout: 5000 }); await page.waitForTimeout(500);
      const n: number = await page.$$eval('.tab.on button', (b: Element[]) => b.length);
      for (let i = 0; i < n; i++) {
        const h = (await page.$$('.tab.on button'))[i]; if (!h) break;
        const info = await h.evaluate((b: Element) => { const e = b as HTMLButtonElement; const r = e.getBoundingClientRect(); return { vis: r.width > 0 && r.height > 0 && !e.disabled, label: (e.innerText || e.id || e.className).slice(0, 40) }; });
        if (!info.vis) continue; current = `${t}:${info.label}`;
        try { await h.click({ timeout: 1500 }); clicked++; } catch { /* covered by an overlay/scrolled away: not a bug */ }
        await page.waitForTimeout(40); await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => (d as HTMLDialogElement).close()));
        const still: string = await page.$eval('nav button.on', (b: Element) => (b as HTMLElement).dataset.tab!).catch(() => t); if (still !== t) await page.click(`nav button[data-tab="${t}"]`).catch(() => {});
      }
    }
    await page.waitForTimeout(1500);
    console.log(`# clicked ${clicked} buttons; 4xx paths: ${JSON.stringify([...fourxx])}`);
    assert.ok(clicked > 80, `expected to click many buttons, clicked ${clicked}`); assert.deepEqual(errors, [], 'no JS errors / 5xx during click-through');
  } finally { await browser.close(); await app.stop?.(); }
});
