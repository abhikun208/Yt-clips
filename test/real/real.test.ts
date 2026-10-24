/**
 * REAL-SERVICE tests. No fake servers. Run on YOUR machine (Termux/VPS) with real credentials:
 *   npm run test:real
 * Each test skips (with the reason printed) when its credential is absent, so a green run only proves what was actually configured.
 * The author's sandbox cannot reach these services, so NONE of this has been executed by the author.
 *
 *   LLM_API_KEY [LLM_API_BASE LLM_API_MODEL]      real chat completion         (Groq free key works)
 *   STT_API_KEY [STT_API_BASE STT_API_MODEL]      real speech-to-text upload
 *   YT_CLIPS_REAL_URL=<video url>                  real yt-dlp metadata + chat/heatmap sidecars
 *   YT_CLIPS_REAL_YOUTUBE=1 (+ OAuth connected)    real channels.list for every connected channel; retention if analytics scope
 *   YT_CLIPS_REAL_UPLOAD=<short.mp4>               real PRIVATE upload + verify (needs gates.publishEnabled; delete it in Studio)
 *   YT_CLIPS_REAL_TELEGRAM=1  (secret `notify`)    real Telegram message to the owner chat
 *   YT_CLIPS_REAL_POST=1                           real PUBLIC test post to every saved Telegram/Discord/Mastodon login (!)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/db.ts';
import { loadConfig } from '../../src/config.ts';
import { runSmoke } from '../../src/smoke.ts';
import { llmChain, sttCreds } from '../../src/ai/settings.ts';
import { which, run } from '../../src/util/proc.ts';
import { fetchSignals } from '../../src/sources/youtube.ts';
import { SecretStore } from '../../src/publish/secrets.ts';
import { TelegramAdapter, DiscordAdapter, MastodonAdapter } from '../../src/publish/direct.ts';
import { notify } from '../../src/notify.ts';
import { detectEncoders } from '../../src/media/encoder.ts';
import { loadExternalSeries } from '../../src/analysis/external.ts';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cfg = loadConfig(); const store = new Store(cfg.dbPath); const env = process.env;
const tmp = () => mkdtempSync(join(tmpdir(), 'ytc-real-'));

test('REAL ffmpeg + hardware encoders (reports what this machine can really use)', async () => {
  const det = await detectEncoders(); console.log('hardware encoders:', JSON.stringify(det));
  const res = await runSmoke(store, cfg); assert.equal(res.find((r) => r.name === 'ffmpeg encode')!.status, 'PASS');
});

test('REAL LLM chat completion', async (t) => {
  if (!llmChain(cfg).length) return t.skip('no LLM configured (set LLM_API_KEY or save one in Setup -> AI)');
  const res = await runSmoke(store, cfg); const llm = res.filter((r) => r.name.startsWith('LLM')); assert.ok(llm.length && llm.every((r) => r.status === 'PASS'), JSON.stringify(llm));
});

test('REAL speech-to-text upload', async (t) => {
  if (!sttCreds(cfg)) return t.skip('no STT configured (set STT_API_KEY or save one in Setup -> AI)');
  const res = await runSmoke(store, cfg); const s = res.find((r) => r.name.startsWith('STT'))!; assert.equal(s.status, 'PASS', s.detail);
});

test('REAL yt-dlp: metadata, live-chat and most-replayed sidecars for YT_CLIPS_REAL_URL', async (t) => {
  if (!env.YT_CLIPS_REAL_URL) return t.skip('set YT_CLIPS_REAL_URL=<a video you may use>');
  if (!(await which('yt-dlp'))) return t.skip('yt-dlp not installed');
  const res = await runSmoke(store, cfg, { url: env.YT_CLIPS_REAL_URL }); const m = res.find((r) => r.name === 'yt-dlp metadata fetch')!; assert.equal(m.status, 'PASS', m.detail);
  const base = join(tmp(), 'clip'); const sig = await fetchSignals(env.YT_CLIPS_REAL_URL, base); console.log('sidecars:', JSON.stringify(sig), '(not every video has chat/heatmap)');
  if (sig.chat || sig.heatmap) assert.ok(loadExternalSeries(base, 3600).length >= 1, 'downloaded sidecar parses into a series');
});

test('REAL YouTube: login per connected channel, retention if the analytics scope was granted', async (t) => {
  if (env.YT_CLIPS_REAL_YOUTUBE !== '1') return t.skip('set YT_CLIPS_REAL_YOUTUBE=1 after connecting a channel');
  const res = await runSmoke(store, cfg); const logins = res.filter((r) => r.name.startsWith('YouTube login') && r.status !== 'SKIP'); assert.ok(logins.length, 'no channel connected'); assert.ok(logins.every((r) => r.status === 'PASS'), JSON.stringify(logins));
  const { collectRetention } = await import('../../src/publish/service.ts'); const r = await collectRetention(store, cfg); console.log('retention:', JSON.stringify(r)); assert.equal(r.errors.length, 0, r.errors.join('; '));
});

test('REAL YouTube PRIVATE upload', async (t) => {
  if (!env.YT_CLIPS_REAL_UPLOAD) return t.skip('set YT_CLIPS_REAL_UPLOAD=<short.mp4> (needs gates.publishEnabled=true in data/config.json)');
  const res = await runSmoke(store, cfg, { upload: env.YT_CLIPS_REAL_UPLOAD, channel: env.YT_CLIPS_REAL_CHANNEL }); const u = res.find((r) => r.name === 'YouTube PRIVATE upload')!; assert.equal(u.status, 'PASS', u.detail); console.log(u.detail);
});

test('REAL Telegram owner notification', async (t) => {
  if (env.YT_CLIPS_REAL_TELEGRAM !== '1') return t.skip('set YT_CLIPS_REAL_TELEGRAM=1 (credentials saved as `notify`)');
  assert.equal(await notify(store, cfg, `real-test:${Date.now()}`, 'yt-clips real test: notifications work'), true);
});

test('REAL PUBLIC test post on Telegram/Discord/Mastodon (only with YT_CLIPS_REAL_POST=1)', async (t) => {
  if (env.YT_CLIPS_REAL_POST !== '1') return t.skip('set YT_CLIPS_REAL_POST=1 to really post a 2-second test video to every saved login');
  const dir = tmp(); const file = join(dir, 'real.mp4'); const g = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=15:d=2', '-pix_fmt', 'yuv420p', file], { timeoutMs: 30_000 }); assert.equal(g.code, 0);
  const sec = SecretStore.forData(cfg.dataDir); let n = 0;
  for (const [name, mk] of [['telegram', (c: Record<string, string>) => new TelegramAdapter(store, c)], ['discord', (c: Record<string, string>) => new DiscordAdapter(store, c)], ['mastodon', (c: Record<string, string>) => new MastodonAdapter(store, c)]] as const) {
    const c = sec.read<Record<string, string>>(name); if (!c) { console.log(`skip ${name}: no saved login`); continue; }
    const ad = mk(c); const { remoteId } = await ad.upload({ filePath: file, title: 'yt-clips test (ignore)', description: 'automated test post', tags: [], visibility: 'unlisted', idempotencyKey: `real:${Date.now()}` });
    const r = await ad.publish(remoteId, null); console.log(name, '->', r && r.remoteId); assert.ok(r && r.remoteId); n++;
  }
  assert.ok(n > 0, 'no direct-platform login saved');
});
void existsSync; void writeFileSync;
