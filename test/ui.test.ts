import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

// Opens the real dashboard in headless Chromium and visits every tab: a JS error (like "liveLoad is not defined") or a red load-error banner fails the test. Skipped where Playwright is not installed.
function loadPlaywright(): { chromium: { launch(): Promise<any> } } | null { for (const base of ['/usr/lib/node_modules/', process.cwd() + '/']) { try { return createRequire(base)('playwright'); } catch { /* try next */ } } return null; }
const pw = loadPlaywright();
test('dashboard: every tab loads in a real browser without JS errors or load-error banners', { skip: !pw, timeout: 90_000 }, async () => {
  const d = tmpDir(); const app = createApp({ host: '127.0.0.1', dataDir: d, rootDir: d, port: 0 } as never); const port = await app.start();
  const b = await pw!.chromium.launch(); const errs: string[] = [];
  try {
    const pg = await b.newPage(); pg.on('pageerror', (e: Error) => errs.push('pageerror: ' + e.message));
    await pg.goto(`http://127.0.0.1:${port}/`); await pg.waitForTimeout(1200);
    for (const t of ['home', 'clips', 'publish', 'schedule', 'insights', 'studio', 'settings']) { await pg.click(`nav button[data-tab="${t}"]`); await pg.waitForTimeout(900); const e: string[] = await pg.$$eval(`#t-${t} .loaderr`, (x: any[]) => x.map((y) => y.innerText.slice(0, 120))); if (e.length) errs.push(`${t}: ${e.join('|')}`); }
  } finally { await b.close(); await app.stop(); }
  assert.deepEqual(errs, []);
});
