import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { tmpDir } from './helpers.ts';
import { buildResearch } from '../src/seo/evidence.ts';

function loadPw(): { chromium: { launch(): Promise<any> } } | null {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return createRequire(import.meta.url)(p); } catch { /* next */ } }
  return null;
}
const pw = loadPw();

test('click-through: clip dialog shows the evidence labels (VERIFIED / ESTIMATE / AI GUESS / NO DATA) and Insights shows the report card', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const T = 'test-token-0123456789'; const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(cfg.dbPath);
  const research = buildResearch({ keywords: ['aim', 'clutch'], suggestions: [], trendsTried: false, trends: [], generatedBy: 'groq:gpt-oss', seoScore: 71 });
  store.exec(`INSERT INTO sources(id, kind, uri, authorized) VALUES (1,'local','r1',1)`); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f1')`);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c1')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1','/x1.mp4',1,?)`, JSON.stringify({ title: 'Real title #Shorts', description: 'd', tags: ['x'], generatedBy: 'groq:gpt-oss', research }));
  store.db.close?.();
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const api = await (await fetch(base + '/api/clips', { headers: { authorization: `Bearer ${T}` } })).json() as { clips: { research: { topic: string }[] | null }[] };
    assert.equal(api.clips[0]!.research?.length, 5, 'API carries the five labelled insights');
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${T}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(base + '/'); await page.waitForSelector('nav button[data-tab="clips"]'); await page.click('nav button[data-tab="clips"]');
    await page.waitForSelector('[data-a="open"]', { timeout: 15000 }); await page.click('[data-a="open"]');
    await page.waitForSelector('#dres details', { timeout: 10000 });
    await page.click('#dres summary'); const txt = await page.$eval('#dres', (e: Element) => (e as HTMLElement).innerText);
    assert.match(txt, /AI GUESS/); assert.match(txt, /ESTIMATE/); assert.match(txt, /NO DATA/); assert.doesNotMatch(txt, /VERIFIED/, 'offline suggestions must never be shown as VERIFIED');
    await page.click('#dclose'); await page.click('nav button[data-tab="analytics"]'); await page.waitForTimeout(1500);
    const rep = await page.$eval('#rep', (e: Element) => (e as HTMLElement).innerText); assert.ok(rep.trim().length > 0, 'report card is not blank'); assert.doesNotMatch(rep, /undefined|\[object/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.stop?.(); }
});
