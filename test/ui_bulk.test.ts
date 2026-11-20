import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { createChannel, ytSecretName } from '../src/channels.ts';
import { tmpDir } from './helpers.ts';

function loadPw(): { chromium: { launch(): Promise<any> } } | null {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { return createRequire(import.meta.url)(p); } catch { /* next */ } }
  return null;
}
const pw = loadPw();

test('click-through: select 2 clips -> Distribute -> pick 2 accounts -> Preview -> Confirm creates one independent job per clip x account', { skip: pw ? false : 'playwright not installed', timeout: 90_000 }, async () => {
  const T = 'test-token-0123456789'; const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(cfg.dbPath); const sec = SecretStore.forData(dataDir);
  const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
  sec.write(ytSecretName(a), { refresh_token: 'RA' }); sec.write(ytSecretName(b), { refresh_token: 'RB' });
  store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f1')`);
  for (const n of [1, 2]) { store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,1,0,6,.5,?)`, n, `c${n}`);
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,1,?)`, n, n, `o${n}`, `/x${n}.mp4`, JSON.stringify({ title: `Real title number ${n} #Shorts`, description: 'd', tags: ['x'] })); }
  store.db.close?.();
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  const browser = await pw!.chromium.launch(); const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${T}` }, viewport: { width: 390, height: 800 } }); const page = await ctx.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(base + '/'); await page.waitForSelector('nav button[data-tab="clips"]'); await page.click('nav button[data-tab="clips"]');
    await page.waitForSelector('[data-sel]', { timeout: 15000 }); const boxes = await page.$$('[data-sel]'); assert.equal(boxes.length, 2);
    for (const x of boxes) await x.check(); await page.waitForSelector('#selgo'); assert.match(await page.$eval('#selbar', (e: Element) => (e as HTMLElement).innerText), /2 clip chuni/);
    await page.click('#selgo'); await page.waitForSelector('[data-ba]'); for (const x of await page.$$('[data-ba]')) await x.check();
    await page.click('#bpre'); await page.waitForSelector('#bgo:not([hidden])'); assert.match(await page.$eval('#bpv', (e: Element) => (e as HTMLElement).innerText), /4 naye job/);
    await page.click('#bgo'); await page.waitForTimeout(1200);
    const rows = await (await fetch(base + '/api/uploads', { headers: { authorization: `Bearer ${T}` } })).json() as { uploads: { clipId?: number; clip_id?: number }[] };
    assert.equal(rows.uploads.length, 4, 'one job per clip x account'); assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.stop?.(); }
});
