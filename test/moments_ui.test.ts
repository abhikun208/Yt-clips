import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { tmpDir } from './helpers.ts';

function loadPw(): { chromium: { launch(): Promise<any> } } | null { for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return createRequire(import.meta.url)(p); } catch { /* next */ } } return null; }
const pw = loadPw();

test('API + Home card: moments summary counts tiers, editorial hold and resources; no page errors', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const T = 'test-token-0123456789'; const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(cfg.dbPath);
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f1')`);
  for (const [i, tier] of ['EXCEPTIONAL', 'STRONG', 'CONDITIONAL', 'REJECTED'].entries()) store.exec(`INSERT INTO moments(video_id, origin, start_sec, end_sec, tier, score, confidence, breakdown_json, missing_json, reasons_json, fingerprint) VALUES (1,'moment',?,?,?,.5,.8,'{}','[]','[]',?)`, i * 40, i * 40 + 20, tier, `m${i}`);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,20,.5,'c1')`); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1','/x.mp4',1)`);
  store.exec(`UPDATE moments SET candidate_id=1 WHERE fingerprint='m2'`); // CONDITIONAL moment-origin clip: waits for approval
  store.db.close?.();
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`; const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const r = await (await fetch(base + '/api/moments/summary', { headers: { authorization: `Bearer ${T}` } })).json() as any;
    assert.equal(r.discovered, 4); assert.equal(r.byTier.EXCEPTIONAL, 1); assert.equal(r.blockedByEditorial, 1); assert.equal(r.readyClips, 0); assert.ok(['ok', 'warn', 'critical'].includes(r.resources.level));
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${T}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(base + '/'); await page.waitForFunction(() => /Discovered/.test(document.querySelector('#momsum')?.textContent ?? ''), null, { timeout: 15000 });
    const txt = await page.$eval('#momcard', (e: Element) => (e as HTMLElement).innerText); assert.match(txt, /Exceptional\s*1/); assert.match(txt, /Editorial hold\s*1/); assert.doesNotMatch(txt, /undefined|\[object/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.stop?.(); }
});

test('Home shows the Publishing audit card with BLOCKED verdict and the exact fix text', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const T = 'test-token-0123456789'; const dataDir = tmpDir(); const old = process.env.PUBLISH_MODE; delete process.env.PUBLISH_MODE;
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`; const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${T}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(base + '/'); await page.waitForFunction(() => /BLOCKED|PUBLIC READY|nahi hua/.test(document.querySelector('#pubsum')?.textContent ?? ''), null, { timeout: 15000 }).catch(async (e: unknown) => { throw new Error(String(e) + ' :: ' + (await page.$eval('#pubsum', (x: Element) => x.textContent)) + ' :: ' + errors.join('|')); });
    const txt = await page.$eval('#pubaudit', (e: Element) => (e as HTMLElement).innerText); assert.match(txt, /BLOCKED/); assert.match(txt, /PUBLISH_MODE=PUBLIC/); assert.doesNotMatch(txt, /undefined|\[object/); assert.deepEqual(errors, []);
  } finally { if (old !== undefined) process.env.PUBLISH_MODE = old; await browser.close(); await app.stop?.(); }
});
