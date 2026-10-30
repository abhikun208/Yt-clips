import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadata } from '../src/seo/metadata.ts';
import { Store } from '../src/db.ts';
import { runDoctor } from '../src/ops/doctor.ts';
import { testConfig } from './helpers.ts';

test('no speech: title/keywords come from the SOURCE title, still flagged generic', () => {
  const m = buildMetadata({ transcript: '', category: 'general', language: 'hi', sourceTitle: 'Free Fire Grandmaster Rush Gameplay', channelName: 'Team Unknown' } as never);
  assert.match(m.title, /Free Fire Grandmaster Rush Gameplay/); assert.ok(m.keywords.some((k) => /grandmaster|gameplay|rush/i.test(k))); assert.equal(m.generic, true);
});

test('doctor tells the owner plainly when cloud STT failed and no local engine exists', async () => {
  const stt = await import('../src/analysis/stt.ts'); const cfg = testConfig(); const store = new Store(':memory:');
  assert.ok(!(await runDoctor(store, cfg, { fix: false })).items.some((i) => i.area === 'speech-to-text'));
  stt.noteApiSttError('fetch failed');
  const old = process.env.PATH; process.env.PATH = '/nonexistent'; delete process.env.YT_CLIPS_STT_CMD;
  try { const it = (await runDoctor(store, cfg, { fix: false })).items.find((i) => i.area === 'speech-to-text'); assert.ok(it, 'reported'); assert.match(it!.action, /install-whisper-cpp/); assert.equal(it!.result, 'manual'); } finally { process.env.PATH = old; }
});

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir, makeFixture } from './helpers.ts';
test('engine=api + unreachable cloud STT falls back to local whisper.cpp (and trips the breaker)', async () => {
  const d = tmpDir(); const bin = join(d, 'bin'); mkdirSync(bin); const model = join(d, 'm.bin'); writeFileSync(model, 'x');
  writeFileSync(join(bin, 'whisper-cli'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then P="$2"; fi; shift; done\necho '{"result":{"language":"hi"},"transcription":[{"offsets":{"from":0,"to":2000},"text":" yeh ek test hai"}]}' > "$P.json"\n`); chmodSync(join(bin, 'whisper-cli'), 0o755);
  const v = join(d, 'v.mp4'); await makeFixture(v, 6);
  const env = { PATH: process.env.PATH, K: process.env.STT_API_KEY, B: process.env.STT_API_BASE, M: process.env.YT_CLIPS_WHISPER_CPP_MODEL, C: process.env.YT_CLIPS_STT_CMD };
  process.env.PATH = `${bin}:${env.PATH}`; process.env.STT_API_KEY = 'k'; process.env.STT_API_BASE = 'http://127.0.0.1:1/v1'; process.env.YT_CLIPS_WHISPER_CPP_MODEL = model; delete process.env.YT_CLIPS_STT_CMD;
  try {
    const { transcribeVideo, resetApiBreaker } = await import('../src/analysis/stt.ts'); resetApiBreaker();
    const r = await transcribeVideo(testConfig({ stt: { mode: 'auto', model: 'small', language: 'auto', engine: 'api' } }), v);
    assert.equal(r.status, 'ok', JSON.stringify(r)); assert.match(r.cues[0]!.text, /yeh ek test/); assert.equal(r.engine, 'whisper-cpp');
  } finally { process.env.PATH = env.PATH; for (const [k, e] of [['STT_API_KEY', env.K], ['STT_API_BASE', env.B], ['YT_CLIPS_WHISPER_CPP_MODEL', env.M], ['YT_CLIPS_STT_CMD', env.C]] as const) { if (e === undefined) delete process.env[k]; else process.env[k] = e; } }
});

test('whisper.cpp + model are found in ~/whisper.cpp without PATH/.env edits', async () => {
  const { detectLocalEngines } = await import('../src/analysis/localStt.ts'); const d = tmpDir(); mkdirSync(join(d, 'whisper.cpp', 'build', 'bin'), { recursive: true }); mkdirSync(join(d, 'whisper.cpp', 'models'));
  writeFileSync(join(d, 'whisper.cpp', 'build', 'bin', 'whisper-cli'), '#!/bin/sh\n'); chmodSync(join(d, 'whisper.cpp', 'build', 'bin', 'whisper-cli'), 0o755); writeFileSync(join(d, 'whisper.cpp', 'models', 'ggml-base.bin'), 'x');
  const old = { H: process.env.HOME, P: process.env.PATH, M: process.env.YT_CLIPS_WHISPER_CPP_MODEL, W: process.env.WHISPER_CPP_DIR }; process.env.HOME = d; process.env.PATH = '/usr/bin:/bin'; delete process.env.YT_CLIPS_WHISPER_CPP_MODEL; delete process.env.WHISPER_CPP_DIR;
  try { const e = (await detectLocalEngines(testConfig())).find((x) => x.id === 'whisper-cpp')!; assert.equal(e.available, true, e.detail); } finally { process.env.HOME = old.H; process.env.PATH = old.P; if (old.M) process.env.YT_CLIPS_WHISPER_CPP_MODEL = old.M; if (old.W) process.env.WHISPER_CPP_DIR = old.W; }
});

test('doctor starts the free whisper.cpp install once a day when no engine exists', async () => {
  const cfg = testConfig(); const store = new Store(':memory:'); let calls = 0; const old = { H: process.env.HOME, P: process.env.PATH }; process.env.HOME = tmpDir(); process.env.PATH = '/usr/bin:/bin';
  try {
    const r1 = await runDoctor(store, cfg, { spawnInstall: () => { calls++; } }); const it = r1.items.find((i) => i.area === 'speech-to-text'); assert.equal(calls, 1); assert.equal(it?.result, 'fixed');
    await runDoctor(store, cfg, { spawnInstall: () => { calls++; } }); assert.equal(calls, 1, 'not again within 24 h');
  } finally { process.env.HOME = old.H; process.env.PATH = old.P; }
});

import { repairVideo } from '../src/ops/repair.ts';
import { sttCreds } from '../src/ai/settings.ts';
test('doctor: closes meta jobs of deleted clips, closes uploads whose video is gone, repairs undecodable source via H.264 re-download', async () => {
  const cfg = testConfig(); const store = new Store(':memory:'); const d = tmpDir();
  const src = store.exec(`INSERT INTO sources(kind, uri, title, authorized) VALUES ('youtube_video','https://youtu.be/abc12345678','t',1)`).lastId;
  const vp = join(d, 'v.mp4'); await makeFixture(vp, 6); const vid = store.exec(`INSERT INTO videos(source_id, path, fingerprint, duration) VALUES (?,?,'fp',14)`, src, vp).lastId;
  const cand = store.exec(`INSERT INTO candidates(video_id, start_sec, end_sec, score, fingerprint) VALUES (?,0,10,1,'c')`, vid).lastId;
  store.exec(`INSERT INTO jobs(kind, key, state, last_error) VALUES ('meta','meta:99','DEAD','unknown clip 99')`);
  store.exec(`INSERT INTO jobs(kind, key, state, last_error) VALUES ('render', ?, 'RETRY', 'raw clip extraction failed (video may be AV1/corrupt — re-download it): [libdav1d] obu')`, `render:${cand}`);
  const clip = store.exec(`INSERT INTO clips(candidate_id, output_id) VALUES (?, 'o')`, cand).lastId;
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, remote_id, error) VALUES (?, 'youtube_shorts', 'UPLOAD_VERIFYING', 'k', 'abc', 'remote video abc not found')`, clip);
  const good = join(d, 'good.mp4'); await makeFixture(good, 6);
  const rep = await runDoctor(store, cfg, { repair: (s, c, id) => repairVideo(s, c, id, { download: async () => { const p = join(d, 'dl.mp4'); (await import('node:fs')).copyFileSync(good, p); return p; } }) });
  assert.equal(store.get<{ state: string }>(`SELECT state FROM jobs WHERE key='meta:99'`)!.state, 'DONE');
  assert.equal(store.get<{ state: string }>(`SELECT state FROM uploads WHERE idempotency_key='k'`)!.state, 'QC_FAILED');
  assert.ok(rep.items.some((i) => i.area === `video ${vid}` && i.result === 'fixed'), JSON.stringify(rep.items));
  assert.match(store.get<{ path: string }>('SELECT path FROM videos WHERE id=?', vid)!.path, /\.h264\.mp4$/);
  assert.equal(store.get<{ state: string }>(`SELECT state FROM jobs WHERE key=?`, `render:${cand}`)!.state, 'PENDING');
});
test('a saved Ollama URL in the STT slot is ignored', () => { const old = process.env.STT_API_BASE; process.env.STT_API_BASE = 'http://127.0.0.1:11434/v1'; try { assert.equal(sttCreds(testConfig()), null); } finally { if (old === undefined) delete process.env.STT_API_BASE; else process.env.STT_API_BASE = old; } });

import { cleanConfig as cc2 } from '../src/channels.ts';
test('channel effects setting is validated', () => { assert.equal(cc2({ effects: 'clean' }, () => true).effects, 'clean'); assert.throws(() => cc2({ effects: 'wild' }, () => true)); });

import { existsSync as ex2, readFileSync } from 'node:fs';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { updateChannel } from '../src/channels.ts';
test('render: a stale output left by an interrupted attempt is replaced (no "Refusing to overwrite"); effects=clean drops grain/dust/flash/LUT/slow-mo', { timeout: 200_000 }, async () => {
  const d = tmpDir(); const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 2, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } }); const s = new Store(cfg.dbPath);
  const src = join(d, 'v.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  updateChannel(s, 1, { config: { effects: 'clean' } } as never, () => true);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!;
  const first = await renderCandidate(s, cfg, cand.id, {});
  const man = JSON.parse(readFileSync(join(cfg.dirs.manifests, `${first.outputId}.json`), 'utf8')); const dims = (man.treatments as { dimension: string; applied: boolean }[]).filter((t) => t.applied).map((t) => t.dimension);
  for (const bad of ['film_grain', 'particles', 'light_leak', 'flash_transition', 'cinematic_lut', 'speed_ramp']) assert.ok(!dims.includes(bad), `${bad} must be off in clean mode: ${dims}`);
  // simulate an interrupted attempt: the clip row never got its path, but the file is on disk
  s.exec('UPDATE clips SET edited_path=NULL, qc_pass=NULL WHERE id=?', first.clipId); assert.ok(ex2(first.editedPath));
  const again = await renderCandidate(s, cfg, cand.id, {}); assert.equal(again.reused, false); assert.ok(ex2(again.editedPath));
  s.close();
});

import { envStatus, applyEnvKeys } from '../src/ai/envkeys.ts';
import { KEY_PREFIX, providerFromKey } from '../src/ai/autodetect.ts';
test('env keys: new providers, odd variable names recognised by key prefix, generic AI_API_KEY + AI_API_BASE', async () => {
  const st = envStatus({ CEREBRAS_API_KEY: 'csk-abc', MY_GEMINI_KEY: 'AIzaSyXYZ', random_token: 'gsk_123', export_me: 'x', AI_API_KEY: 'zzz', AI_API_BASE: 'https://x.example/v1' } as never);
  const names = st.filter((x) => x.var).map((x) => `${x.provider}:${x.var}`);
  for (const n of ['cerebras:CEREBRAS_API_KEY', 'gemini:MY_GEMINI_KEY', 'groq:random_token', 'custom:AI_API_KEY']) assert.ok(names.includes(n), `${n} in ${names}`);
  assert.equal(providerFromKey('hf_abc'), 'huggingface'); assert.equal(providerFromKey('nvapi-1'), 'nvidia'); assert.ok(KEY_PREFIX['csk-']);
  const cfg = testConfig(); const calls: string[] = [];
  const fetchFn = (async (url: string, init?: { method?: string }) => { calls.push(`${init?.method ?? 'GET'} ${url}`); if (/\/models$/.test(url)) return new Response(JSON.stringify({ data: [{ id: 'my-chat-70b' }] }), { status: 200 }); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await applyEnvKeys(cfg, { env: { AI_API_KEY: 'secret-key', AI_API_BASE: 'https://x.example/v1/' } as never, fetchFn });
  assert.equal(r[0]!.provider, 'custom'); assert.equal(r[0]!.report?.ok, true, JSON.stringify(r[0]!.report)); assert.ok(calls.some((c) => c.startsWith('POST https://x.example/v1/chat/completions')));
});

import { pickMusicTrack, loadLibrary } from '../src/edit/music.ts';
test('music library: mood match first, deterministic rotation, only listed files, licence kept, volume clamped', () => {
  const d = tmpDir(); mkdirSync(join(d, 'music')); for (const f of ['a.mp3', 'b.mp3', 'c.mp3', 'notes.txt']) writeFileSync(join(d, 'music', f), 'x');
  assert.equal(pickMusicTrack(d, { seed: 0 })?.path.endsWith('a.mp3'), true); assert.equal(pickMusicTrack(d, { seed: 1 })?.path.endsWith('b.mp3'), true); // plain folder = rotation
  writeFileSync(join(d, 'music', 'library.json'), JSON.stringify([{ file: 'b.mp3', mood: ['comedy'], license: 'YT Audio Library', volume: 5 }, { file: 'c.mp3', mood: ['action'] }, { file: 'missing.mp3' }]));
  const lib = loadLibrary(d); assert.equal(lib.curated, true); assert.deepEqual(lib.tracks.map((t) => t.file), ['b.mp3', 'c.mp3']); // a.mp3 not listed → unused, missing.mp3 ignored
  const p = pickMusicTrack(d, { mood: 'comedy', seed: 7 })!; assert.ok(p.path.endsWith('b.mp3') && p.matchedMood && p.license === 'YT Audio Library' && p.volume === 1);
  assert.equal(pickMusicTrack(d, { mood: 'sad', seed: 0 })!.matchedMood, false); assert.equal(pickMusicTrack(join(d, 'none'), {}), undefined);
});
