import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotEnv, loadDotEnv } from '../src/env-boot.ts';
import { fitTitle, buildStyledAss } from '../src/edit/captions.ts';
import { sttLang } from '../src/analysis/stt.ts';
import { buildVideoGraph } from '../src/edit/filters.ts';
import { envStatus } from '../src/ai/envkeys.ts';
import { tmpDir, testConfig, makeFixture } from './helpers.ts';

test('.env parser: BOM, CRLF, export, spaces, quotes, inline comments, odd keys', () => {
  const p = parseDotEnv('﻿# c\r\nGROQ_API_KEY = "gsk_abc123"\r\nexport GEMINI_API_KEY=AIzaXYZ # my key\r\nSINGLE=\'a b\'\r\nEMPTY=\r\nURL=http://x/?a=b#frag\r\nbad line\r\nMY-KEY=1\r\n');
  assert.equal(p.GROQ_API_KEY, 'gsk_abc123'); assert.equal(p.GEMINI_API_KEY, 'AIzaXYZ'); assert.equal(p.SINGLE, 'a b'); assert.equal(p.EMPTY, ''); assert.equal(p.URL, 'http://x/?a=b#frag'); assert.equal(p['MY-KEY'], '1');
});
test('.env is found in the project folder even when cwd differs; real env wins', () => {
  const proj = tmpDir(), other = tmpDir(); writeFileSync(join(proj, '.env'), 'ZZ_TEST_A=file\nZZ_TEST_B=file\n'); process.env.ZZ_TEST_B = 'real';
  const r = loadDotEnv(other, proj); assert.equal(r.file, join(proj, '.env')); assert.equal(process.env.ZZ_TEST_A, 'file'); assert.equal(process.env.ZZ_TEST_B, 'real');
  const env = { GROQ_API_KEY: 'gsk_' + 'a'.repeat(40) }; assert.ok(envStatus(env as never).some((x) => x.provider === 'groq' && x.var));
});
test('hook title: wrapped to <=2 lines, shrunk to fit 1080px, never overflows', () => {
  for (const t of ['gets away from the water, you will be in trouble', 'Jethalal ki problem solve ho gayi to 11 kg laddu', 'Short hook']) {
    const out = fitTitle(t, 1080, 69, 50); const size = Number(/\\fs(\d+)/.exec(out)?.[1] ?? 69); const lines = out.replace(/\{[^}]*\}/g, '').split('\\N');
    assert.ok(lines.length <= 2, out); for (const l of lines) assert.ok(l.length * 0.62 * size <= 1080 - 140 + 1, `${l} @${size}`);
  }
  assert.ok(fitTitle('x '.repeat(80), 1080, 69, 50).replace(/\{[^}]*\}/g, '').split('\\N').length <= 2);
  const ass = buildStyledAss([], 0, 10, 'gets away from the water, you will be in trouble', { width: 1080, height: 1920 }).ass; assert.match(ass, /Title,,0,0,0,,\{\\fad.*\\N/);
});
test('stt language: auto -> hi (India-first), explicit/off respected', () => {
  const cfg = testConfig(); assert.equal(sttLang(cfg), 'hi'); assert.equal(sttLang(cfg, 'en'), 'en'); assert.equal(sttLang(cfg, 'auto'), 'hi');
  cfg.stt.indiaFirst = false; assert.equal(sttLang(cfg), 'auto');
});
test('fit_blur trims empty sides of a wide source (bigger picture), not of a vertical one', () => {
  const base = { inW: 1920, inH: 1080, outW: 1080, outH: 1920, fps: 30, duration: 10, mood: 'general' as never, reframe: 'fit_blur' as const, zoom: false, glow: false, fade: false };
  const g = (o: object) => buildVideoGraph({ ...base, ...o } as never); const a = JSON.stringify(g({ fitZoom: 0.8 })), b = JSON.stringify(g({ fitZoom: 1 })), c = JSON.stringify(g({ fitZoom: 0.8, inW: 1080, inH: 1920 }));
  assert.match(a, /crop=w='trunc\(iw\*0\.800/); assert.doesNotMatch(b, /iw\*0\.800/); assert.doesNotMatch(c, /iw\*0\.800/);
});

import { synthesize } from '../src/tts/engine.ts';
import { CATALOG } from '../src/ai/autodetect.ts';
test('VoiceStudio TTS (opt-in) is used when its /v1/audio/speech answers; falls through silently when it fails', async () => {
  const d = tmpDir(); let called = ''; const ok = (async (u: string) => { called = String(u); return new Response(Buffer.alloc(2000, 1)); }) as unknown as typeof fetch;
  const r = await synthesize('namaste doston', d, { env: { YT_CLIPS_VOICESTUDIO_URL: 'http://127.0.0.1:3900/' } as never, fetchFn: ok }); assert.equal(r?.provider, 'voicestudio'); assert.equal(called, 'http://127.0.0.1:3900/v1/audio/speech');
  const bad = (async () => { throw new Error('down'); }) as unknown as typeof fetch; const old = process.env.PATH; process.env.PATH = '/nonexistent';
  try { assert.equal(await synthesize('doosra text', d, { env: { YT_CLIPS_VOICESTUDIO_URL: 'http://127.0.0.1:3900' } as never, fetchFn: bad }), null); } finally { process.env.PATH = old; }
});
test('new free providers are in the catalogue with env names', () => {
  for (const id of ['llm7', 'modelscope', 'siliconflow', 'zai', 'nebius', 'ai21']) assert.ok(CATALOG.some((c) => c.id === id), id);
  assert.ok(envStatus({ SILICONFLOW_API_KEY: 'sk-' + 'a'.repeat(30) } as never).some((x) => x.provider === 'siliconflow'));
});

import { lintPackage } from '../src/seo/metadata.ts';
test('package lint: advisory warnings from visible words only', () => {
  assert.deepEqual(lintPackage({ title: 'Jethalal ki musibat: 11 kg laddu ka vaada', description: 'Is clip me Jethalal bhagwan se vaada karta hai ki problem solve hui to laddu dega.' }), []);
  const w = lintPackage({ title: 'THIS IS A VERY LOUD TITLE THAT GOES ON AND ON FOR TOO LONG TO FIT', description: 'x' }, 'this is a very loud title that goes on and on for too long to fit');
  assert.ok(w.some((x) => /60/.test(x)) && w.some((x) => /ALL CAPS/.test(x)) && w.some((x) => /repeats/.test(x)) && w.some((x) => /short/.test(x)));
});

import { createApp } from '../src/server/app.ts';
test('scale: /api/channels with 60 channels answers 80 concurrent callers quickly (shared + cached), and status stays responsive', async () => {
  const T = 'load-token-0123456789'; const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const port = await app.start(); const b = `http://127.0.0.1:${port}`; const H = { authorization: `Bearer ${T}` };
  try {
    for (let i = 0; i < 60; i++) app.store.exec(`INSERT INTO channels(slug,name) VALUES(?,?)`, `c${i}`, `C${i}`);
    const t0 = Date.now(); const rs = await Promise.all([...Array.from({ length: 80 }, () => fetch(`${b}/api/channels`, { headers: H })), fetch(`${b}/api/status`, { headers: H })]);
    assert.ok(rs.every((r) => r.status === 200)); const j = await rs[0]!.json() as { channels: unknown[] }; assert.ok(j.channels.length >= 61); assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0}ms`);
    const t1 = Date.now(); await fetch(`${b}/api/channels`, { headers: H }); assert.ok(Date.now() - t1 < 500, 'second call is served from the 15 s cache');
    await fetch(`${b}/api/channels`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fresh One' }) });
    const j2 = await (await fetch(`${b}/api/channels`, { headers: H })).json() as { channels: { name: string }[] }; assert.ok(j2.channels.some((c) => c.name === 'Fresh One'), 'a write clears the cache');
  } finally { await app.stop(); }
});

import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { renderCandidate } from '../src/edit/render.ts';

import { existsSync } from 'node:fs';
test('render:N never fails with "Refusing to overwrite": moved folder is re-pointed; a file owned by another clip gets a fresh name', { timeout: 280_000 }, async () => {
  const d = tmpDir(); const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 2, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } }); const s = new Store(cfg.dbPath);
  const src = join(d, 'v.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!; const first = await renderCandidate(s, cfg, cand.id, {});
  s.exec('UPDATE clips SET edited_path=? WHERE id=?', '/old/folder/data/edited/x.mp4', first.clipId); // data folder was moved/renamed
  const moved = await renderCandidate(s, cfg, cand.id, {}); assert.equal(moved.reused, true); assert.equal(moved.editedPath, first.editedPath);
  s.exec('PRAGMA foreign_keys=OFF'); s.exec('UPDATE clips SET candidate_id=999999 WHERE id=?', first.clipId); s.exec('PRAGMA foreign_keys=ON'); // the file is now owned by some other clip row
  const other = await renderCandidate(s, cfg, cand.id, {}); assert.equal(other.reused, false); assert.notEqual(other.editedPath, first.editedPath); assert.ok(existsSync(first.editedPath), 'owner file untouched'); assert.ok(existsSync(other.editedPath));
  s.close();
});

import { runDoctor } from '../src/ops/doctor.ts';
test('doctor re-queues jobs that died with the old "Refusing to overwrite" error (fixed now)', async () => {
  const s = new Store(':memory:'); s.exec(`INSERT INTO jobs(kind,key,state,attempts,run_after,last_error,payload_json,updated_at) VALUES('render','render:26','DEAD',5,0,'Refusing to overwrite existing output /x/y.mp4','{}','x')`);
  await runDoctor(s, testConfig(), { fix: true }); assert.equal(s.get<{ state: string }>(`SELECT state FROM jobs WHERE key='render:26'`)!.state, 'PENDING');
});
