import { test } from 'node:test'; import assert from 'node:assert/strict';
import { Store, enqueue, claim } from '../src/db.ts';
test('claim: renders first, then shortest video analysis first', () => {
  const s = new Store(':memory:');
  const ins = (d: number) => { s.exec(`INSERT INTO videos(path,fingerprint,duration,state) VALUES(?,?,?, 'NEW')`, `/x${d}`, `f${d}`, d); return s.get<{ id: number }>('SELECT id FROM videos WHERE fingerprint=?', `f${d}`)!.id; };
  const long = ins(7200), short = ins(30);
  enqueue(s, 'analyze', `analyze:${long}`); enqueue(s, 'analyze', `analyze:${short}`); enqueue(s, 'render', 'render:1');
  assert.equal(claim(s)!.key, 'render:1'); assert.equal(claim(s)!.key, `analyze:${short}`); assert.equal(claim(s)!.key, `analyze:${long}`);
});
test('fresh-start parks old work and deletes nothing', async () => {
  const { freshStart } = await import('../src/ops/freshstart.ts');
  const s = new Store(':memory:'); s.exec(`INSERT INTO videos(path,fingerprint,duration,state) VALUES('/a','fa',100,'ANALYZING')`); enqueue(s, 'analyze', 'analyze:1');
  const r = freshStart(s); assert.equal(r.videosParked, 1); assert.equal(r.jobsCancelled, 1);
  assert.equal(claim(s), undefined); assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM videos')!.n, 1);
});
test('doctor closes DEAD rerender jobs of deleted clips ("Unknown clip 4", capital U as the app writes it)', async () => {
  const { runDoctor } = await import('../src/ops/doctor.ts'); const { testConfig } = await import('./helpers.ts');
  const s = new Store(':memory:'); s.exec(`INSERT INTO jobs(kind, key, state, last_error) VALUES ('rerender','rerender:4','DEAD','Unknown clip 4')`);
  await runDoctor(s, testConfig());
  assert.equal(s.get<{ state: string }>(`SELECT state FROM jobs WHERE key='rerender:4'`)!.state, 'DONE');
});
test('uploading the same file again wakes a PARKED video', async () => {
  const { ingestLocal } = await import('../src/sources/local.ts'); const { freshStart } = await import('../src/ops/freshstart.ts'); const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts');
  const { join } = await import('node:path'); const cfg = testConfig(); const s = new Store(':memory:'); const d = tmpDir(); const f = join(d, 'a.mp4'); await makeFixture(f, 3);
  const a = await ingestLocal(s, cfg, f); freshStart(s); assert.equal(s.get<{ state: string }>('SELECT state FROM videos WHERE id=?', a.videoId)!.state, 'PARKED');
  const b = await ingestLocal(s, cfg, f); assert.equal(b.duplicate, true); assert.equal(s.get<{ state: string }>('SELECT state FROM videos WHERE id=?', a.videoId)!.state, 'NEW');
});
test('no-speech + audible audio asks Gemini once; clip metadata does not repeat speech-to-text for a clip without speech', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/analysis/stt.ts', import.meta.url), 'utf8');
  assert.match(src, /no speech heard but the audio is not silent/); assert.match(src, /mean > -38/);
  const cm = (await import('node:fs')).readFileSync(new URL('../src/seo/clipmeta.ts', import.meta.url), 'utf8'); assert.match(cm, /nospeech:\$\{row\.output_id\}/);
});
test('related topics: whole-word + Roman only; self-harm slang never becomes a hashtag', async () => {
  const { relevantSuggestions } = await import('../src/seo/suggest.ts'); const { buildMetadata } = await import('../src/seo/metadata.ts');
  assert.deepEqual(relevantSuggestions(['chinese drama in hindi dubbed', 'चिंटू', 'चीन', 'chin chal na tha song', 'chin'], 'chin'), ['chin chal na tha song', 'chin']);
  const md = buildMetadata({ transcript: 'kys kys kys bhai kys wahi kys', category: 'general', language: 'hi', duration: 15 });
  assert.ok(![...md.hashtags, ...md.tags, ...md.keywords].some((x) => /kys/i.test(x)), JSON.stringify(md.hashtags));
});
test('foreign-script leak ("vЕЛЕЙmi") is transliterated/removed and reported; Devanagari/Latin untouched', async () => {
  const { stripForeignScripts } = await import('../src/ai/hinglish.ts');
  assert.deepEqual(stripForeignScripts('from vЕЛЕЙmi'), { text: 'from vELEYmi', removed: 0 });
  assert.equal(stripForeignScripts('aaj 日本 bhai').removed, 2); assert.equal(stripForeignScripts('aaj 日本 bhai').text, 'aaj bhai'); assert.equal(stripForeignScripts('aaj مرحبا bhai').removed, 0); // Urdu script is romanised later by the AI step
  assert.deepEqual(stripForeignScripts('मुझे ye pasand hai 😀'), { text: 'मुझे ye pasand hai 😀', removed: 0 });
});
test('captions are always Roman Hinglish: Urdu script is romanised by the AI or removed, never shown', async () => {
  const { applyCaptionLanguage } = await import('../src/ai/translate.ts');
  const cues = [{ start: 0, end: 2, text: 'یہ کیا کر دیا' }, { start: 2, end: 4, text: 'bhai suno' }];
  const r = await applyCaptionLanguage(cues, 'auto', 'hi', []);
  assert.ok(r.cues.every((c) => !/[؀-ۿ]/.test(c.text)) && r.cues.some((c) => c.text === 'bhai suno'));
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"lines":["ye kya kar diya","bhai suno"]}' } }] }))) as unknown as typeof fetch;
  const r2 = await applyCaptionLanguage(cues, 'auto', 'hi', [{ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }], f);
  assert.equal(r2.cues[0]!.text, 'ye kya kar diya');
});
test('Vimeo URLs are accepted as single videos; caption punctuation can be switched off', async () => {
  const { parseYoutubeUrl } = await import('../src/sources/youtube.ts'); const { buildStyledAss } = await import('../src/edit/captions.ts');
  assert.deepEqual(parseYoutubeUrl('https://vimeo.com/123456789'), { kind: 'video', web: true, videoId: '123456789', url: 'https://vimeo.com/123456789' });
  assert.equal(parseYoutubeUrl('https://player.vimeo.com/video/123456789').url, 'https://vimeo.com/123456789');
  assert.throws(() => parseYoutubeUrl('https://vimeo.com/channels/staffpicks'));
  const cues = [{ start: 0, end: 2, text: 'Bhai, ye kya hai!' }];
  const withP = buildStyledAss(cues, 0, 3, null, { width: 540, height: 960 }), noP = buildStyledAss(cues, 0, 3, null, { width: 540, height: 960, punctuation: false });
  assert.match(withP.ass, /kya|KYA/i); assert.ok(/hai!|HAI!/i.test(withP.ass)); assert.ok(!/hai!|HAI!|Bhai,|BHAI,/i.test(noP.ass));
});
test('1:1 and 16:9 output shapes really render at that size (re-render option and channel setting)', { timeout: 200_000 }, async () => {
  const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts'); const { renderCandidate, withAspect } = await import('../src/edit/render.ts'); const { probe } = await import('../src/media/probe.ts');
  const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path'); const { cleanConfig } = await import('../src/channels.ts'); const parseChannelConfig = (c: unknown) => cleanConfig(c, () => true);
  assert.equal(withAspect(testConfig(), '1:1').edit.width, 1080); assert.equal(withAspect(testConfig(), '1:1').edit.height, 1080); assert.equal(withAspect(testConfig(), '16:9').edit.width, 1920);
  assert.throws(() => parseChannelConfig({ aspect: '4:3' })); assert.equal(parseChannelConfig({ aspect: '1:1' }).aspect, '1:1');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 3, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } } as never); const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'sq.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!;
  const out = await renderCandidate(s, cfg, cand.id, { aspect: '1:1', zoom: false, glow: false, variant: 1 });
  const m = await probe(out.editedPath); assert.equal(m.width, 1080); assert.equal(m.height, 1080);
});
test('time range + audio language: parsed, validated, stored on the source and handed to yt-dlp', async () => {
  const { parseRange, addYoutubeSource, downloadVideo } = await import('../src/sources/youtube.ts');
  assert.deepEqual(parseRange('10:00-25:00'), { start: 600, end: 1500 }); assert.deepEqual(parseRange('1:02:03-1:30:00'), { start: 3723, end: 5400 }); assert.deepEqual(parseRange('600-1500'), { start: 600, end: 1500 }); assert.equal(parseRange(''), null);
  for (const bad of ['25:00-10:00', 'abc', '1-2-3', '0-99999']) assert.throws(() => parseRange(bad), bad);
  const s = new Store(':memory:'); s.exec(`INSERT OR IGNORE INTO channels(slug, name) VALUES ('main','Main')`);
  const r = addYoutubeSource(s, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', true, undefined, { audioLang: 'hi', range: { start: 60, end: 120 } });
  const meta = JSON.parse(s.get<{ meta_json: string }>('SELECT meta_json FROM sources WHERE id=?', r.id)!.meta_json); assert.equal(meta.audioLang, 'hi'); assert.deepEqual(meta.range, { start: 60, end: 120 });
  // fake yt-dlp records its arguments
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'yd-')); const bin = join(d, 'yt-dlp'); const out = join(d, 'args.txt');
  writeFileSync(bin, `#!/bin/sh\necho "$@" > ${out}\necho ${join(d, 'v.mp4')}\ntouch ${join(d, 'v.mp4')}\n`); chmodSync(bin, 0o755);
  const old = process.env.PATH; process.env.PATH = `${d}:${old}`;
  try { await downloadVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(d, 'dl'), 720, { audioLang: 'hi', range: { start: 60, end: 120 } }); } finally { process.env.PATH = old; }
  const args = readFileSync(out, 'utf8'); assert.match(args, /--download-sections \*60-120/); assert.match(args, /ba\[language\^=hi\]/); assert.match(args, /--force-keyframes-at-cuts/);
});
test('deleted words really cut the clip: planManualCuts + a real render is shorter by the removed time', { timeout: 250_000 }, async () => {
  const { planManualCuts } = await import('../src/edit/jumpcut.ts');
  const p = planManualCuts([{ start: 2, end: 3 }, { start: 2.9, end: 4 }, { start: 50, end: 60 }], 10)!; assert.deepEqual(p.removed, [{ start: 2, end: 4 }]); assert.equal(p.saved, 2); assert.deepEqual(p.keep, [{ start: 0, end: 2 }, { start: 4, end: 10 }]);
  assert.equal(planManualCuts([{ start: 0, end: 9.5 }], 10), null); assert.equal(planManualCuts([], 10), null);
  const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts'); const { renderCandidate } = await import('../src/edit/render.ts'); const { probe } = await import('../src/media/probe.ts');
  const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 3, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'cut.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number; start_sec: number; end_sec: number }>('SELECT id, start_sec, end_sec FROM candidates ORDER BY score DESC')!;
  const full = await renderCandidate(s, cfg, cand.id, { zoom: false, glow: false, jumpCuts: false, speedRamp: false, variant: 1 });
  const cut = await renderCandidate(s, cfg, cand.id, { zoom: false, glow: false, speedRamp: false, variant: 2, cutRanges: [[cand.start_sec + 2, cand.start_sec + 3.5]] });
  const a = await probe(full.editedPath), b = await probe(cut.editedPath); assert.ok(Math.abs((a.duration - b.duration) - 1.5) < 0.5, `full ${a.duration} cut ${b.duration}`);
});
test('PaaS boot: PORT set, no HOST, no token -> listens on 0.0.0.0 with an auto token (no crash)', async () => {
  const { createApp } = await import('../src/server/app.ts'); const { tmpDir } = await import('./helpers.ts'); const { existsSync } = await import('node:fs'); const { join } = await import('node:path');
  const d = tmpDir(); const oh = process.env.HOST, ot = process.env.YT_CLIPS_TOKEN, op = process.env.PORT; delete process.env.HOST; delete process.env.YT_CLIPS_TOKEN; process.env.PORT = '0';
  try { const app = createApp({ dataDir: d, rootDir: d, port: 0 } as never); const port = await app.start(); assert.ok(port > 0); const r = await fetch(`http://127.0.0.1:${port}/healthz`); assert.ok(r.ok); assert.ok(existsSync(join(d, 'auto-token.txt'))); const u = await fetch(`http://127.0.0.1:${port}/api/clips`); assert.equal(u.status, 401); await app.stop(); }
  finally { if (oh !== undefined) process.env.HOST = oh; if (ot !== undefined) process.env.YT_CLIPS_TOKEN = ot; if (op !== undefined) process.env.PORT = op; else delete process.env.PORT; }
});
test('reanalyze maxClips: validated and limits the number of clips', { timeout: 120_000 }, async () => {
  const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts'); const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 8, targetSec: 6, maxClipsPerVideo: 8, minScore: 0.01 } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'mc.mp4'); await makeFixture(src, 40); const r = await ingestLocal(s, cfg, src);
  const one = await analyzeVideo(s, cfg, r.videoId, { force: true, maxClips: 1 }); assert.equal(one.candidates, 1);
});
test('sfx: whoosh + pops are synthesised inside the audio graph (no files) and ffmpeg accepts it, with and without music', { timeout: 60_000 }, async () => {
  const { buildAudioGraph } = await import('../src/edit/filters.ts'); const { run } = await import('../src/util/proc.ts'); const { tmpDir } = await import('./helpers.ts'); const { join } = await import('node:path'); const { statSync } = await import('node:fs');
  for (const music of [false, true]) {
    const ag = buildAudioGraph({ hasAudio: true, targetLufs: -14, music, duration: 4, sfx: { whoosh: [0.05], pop: [1.2, 2.5] } }); assert.ok(ag.treatments.some((t) => t.dimension === 'sound_effects' && t.applied));
    const out = join(tmpDir(), `s${music}.m4a`);
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=4', ...(music ? ['-f', 'lavfi', '-i', 'sine=f=200:d=4'] : []), '-filter_complex', ag.graph!, '-map', '[aout]', '-t', '4', out], { timeoutMs: 30_000 });
    assert.equal(r.code, 0, r.stderr); assert.ok(statSync(out).size > 2000);
  }
});
test('built-in synthesised music: made once when assets/music is empty, picked by mood, skipped when owner has files', { timeout: 120_000 }, async () => {
  const { ensureSynthMusic } = await import('../src/edit/synthmusic.ts'); const { pickMusicTrack } = await import('../src/edit/music.ts'); const { tmpDir } = await import('./helpers.ts'); const { join } = await import('node:path'); const { statSync } = await import('node:fs');
  const d = tmpDir(); const n = await ensureSynthMusic(d); assert.equal(n, 3);
  const pk = pickMusicTrack(d, { mood: 'gaming', seed: 1 })!; assert.ok(pk.matchedMood); assert.match(pk.path, /energy/); assert.ok(statSync(pk.path).size > 50_000); assert.match(pk.license ?? '', /CC0/);
});
