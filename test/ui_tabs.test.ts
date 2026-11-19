import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

// Real-browser check of the 8-tab dashboard. Skipped where Playwright/Chromium is not installed (CI has no npm deps by design).
function loadPw(): { chromium: { launch(): Promise<any> } } | null {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return createRequire(import.meta.url)(p); } catch { /* next */ } }
  return null;
}
const pw = loadPw();

test('8 tabs: every tab opens, shows its own cards, loads without JS errors; legacy #hashes map to the new tabs', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const TOKEN = 'test-token-0123456789'; const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message)); page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' && !/favicon|401|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
    await page.goto(base + '/'); await page.waitForSelector('nav button[data-tab="home"]', { timeout: 15000 });
    const tabs = await page.$$eval('nav button[data-tab]', (b: Element[]) => b.map((x) => (x as HTMLElement).dataset.tab)); assert.deepEqual(tabs, ['home', 'sources', 'clips', 'studio', 'queue', 'accounts', 'analytics', 'settings']);
    const want: Record<string, string[]> = { sources: ['Video add karo', 'Channels / sources'], queue: ['Upload queue', 'Distribution', 'Manual post tasks', 'Comments'], accounts: ['Connected Accounts', 'Social accounts login', 'Platform logins', 'Naya channel'], analytics: ['YouTube live status', 'Account / platform / video performance'], settings: ['Autopilot', 'AI keys'], studio: ['Caption style'], clips: ['Review inbox'], home: ['Aapka kaam abhi'] };
    for (const t of tabs as string[]) {
      await page.click(`nav button[data-tab="${t}"]`); await page.waitForTimeout(700);
      const active = await page.$$eval('.tab.on', (s: Element[]) => s.map((x) => x.id)); assert.equal(active.length, 1, `exactly one visible section for ${t}: ${active}`);
      const text: string = await page.$eval('.tab.on', (s: Element) => (s as HTMLElement).innerText); for (const h of want[t]!) assert.ok(text.includes(h), `tab ${t} must show "${h}"`);
    }
    for (const [hash, tab] of [['publish', 'queue'], ['schedule', 'accounts'], ['insights', 'analytics']] as const) { await page.goto(`${base}/#${hash}`); await page.reload(); await page.waitForTimeout(900); assert.equal(await page.$eval('nav button.on', (b: Element) => (b as HTMLElement).dataset.tab), tab); }
    assert.deepEqual(errors, [], 'no JS errors while opening all tabs');
  } finally { await browser.close(); await app.stop?.(); }
});
