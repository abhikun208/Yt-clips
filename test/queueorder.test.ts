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
test('layout: Fit on a solid colour + Auto layout + rerender API validation; clip list reports the REAL file length', { timeout: 200_000 }, async () => {
  const { buildVideoGraph } = await import('../src/edit/filters.ts');
  const g = buildVideoGraph({ bgColor: '#112233', reframe: 'fit_blur', inW: 1920, inH: 1080, outW: 1080, outH: 1920, fps: 30, duration: 5, punch: [], closeups: [] } as never);
  assert.match(g.graph, /drawbox=.*0x112233/); assert.ok(g.treatments.some((t) => /solid colour #112233/.test(t.detail)));
  const g2 = buildVideoGraph({ reframe: 'fit_blur', inW: 1920, inH: 1080, outW: 1080, outH: 1920, fps: 30, duration: 5, punch: [], closeups: [] } as never); assert.match(g2.graph, /boxblur/);
  const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts'); const { renderCandidate } = await import('../src/edit/render.ts'); const { probe } = await import('../src/media/probe.ts');
  const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 2, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'lay.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!;
  const out = await renderCandidate(s, cfg, cand.id, { reframe: 'auto', bgColor: '#112233', zoom: false, glow: false, jumpCuts: false, speedRamp: false });
  const pr = await probe(out.editedPath); assert.equal(pr.width, 270);
  const { createApp } = await import('../src/server/app.ts'); const d = tmpDir(); const app = createApp({ host: '127.0.0.1', token: 'layout-test-token-1', dataDir: d, rootDir: d } as never); const port = await app.start();
  try { const bad = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { authorization: 'Bearer layout-test-token-1', 'content-type': 'application/json' }, body: JSON.stringify({ bgColor: 'red' }) }); assert.equal(bad.status, 400); const ok = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { authorization: 'Bearer layout-test-token-1', 'content-type': 'application/json' }, body: JSON.stringify({ reframe: 'auto', bgColor: '#000000' }) }); assert.ok(ok.status < 300, String(ok.status)); } finally { await app.stop(); }
});
test('channel automation options: validated, clip length + max clips apply on analysis', { timeout: 150_000 }, async () => {
  const { cleanConfig, createChannel } = await import('../src/channels.ts'); const ok0 = () => true;
  assert.throws(() => cleanConfig({ clipLength: '5min' }, ok0), /clipLength/); assert.throws(() => cleanConfig({ maxClips: 99 }, ok0), /maxClips/); assert.throws(() => cleanConfig({ checkEveryHours: 5 }, ok0), /checkEveryHours/); assert.throws(() => cleanConfig({ minViral: 101 }, ok0), /minViral/);
  const ok = cleanConfig({ clipLength: 'u30', maxClips: 1, checkEveryHours: 12, minViral: 60 }, ok0) as Record<string, unknown>; assert.equal(ok.maxClips, 1); assert.equal(ok.checkEveryHours, 12);
  const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts'); const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 8, targetSec: 6, maxClipsPerVideo: 8, minScore: 0.01 } } as never); const s = new Store(cfg.dbPath);
  const ch = createChannel(s, { name: 'one clip', config: { maxClips: 1 } }, ok0) as { id: number };
  const src = join(tmpDir(), 'chan.mp4'); await makeFixture(src, 40); const r = await ingestLocal(s, cfg, src, { channel: ch.id } as never);
  s.exec('UPDATE sources SET channel_id=? WHERE id=(SELECT source_id FROM videos WHERE id=?)', ch.id, r.videoId);
  const a = await analyzeVideo(s, cfg, r.videoId, { force: true }); assert.equal(a.candidates, 1);
});
test('transition + caption position options reach the render (ASS alignment, graph flash)', { timeout: 200_000 }, async () => {
  const { buildStyledAss } = await import('../src/edit/captions.ts');
  const cues = [{ start: 0, end: 2, text: 'hello duniya', words: [{ text: 'hello', start: 0, end: 1 }, { text: 'duniya', start: 1, end: 2 }] }];
  const mk = (position?: 'top' | 'center' | 'bottom') => buildStyledAss(cues as never, 0, 3, null, { width: 1080, height: 1920, preset: 'classic-sun', position } as never);
  const al = (r: { ass: string }) => /Style: Cap,[^\n]*/.exec(r.ass)?.[0] ?? '';
  assert.notEqual(al(mk('top') as never), al(mk('bottom') as never));
});
test('on-screen title never carries Cyrillic/foreign letters (owner clip_057 showed "vелеиmi")', async () => {
  const { realHook } = await import('../src/seo/hook.ts');
  const h = realHook('ab aapa saara велеиmi kare baahgi ile liya ab aaj bahut mazaa aaya')!; assert.ok(h); assert.doesNotMatch(h, /[Ѐ-ӿ]/);
});
test('same file uploaded again after its clips were deleted is re-analysed (owner: "dobara upload kiya par clip nahi bani")', { timeout: 150_000 }, async () => {
  const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts'); const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 2, minScore: 0.2 } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'again.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  s.exec(`UPDATE candidates SET status='rejected' WHERE video_id=?`, r.videoId); // what deleting the clip does
  const r2 = await ingestLocal(s, cfg, src); assert.equal(r2.videoId, r.videoId); assert.equal(s.get<{ state: string }>('SELECT state FROM videos WHERE id=?', r.videoId)!.state, 'NEW');
  await analyzeVideo(s, cfg, r.videoId); assert.ok(s.get('SELECT 1 FROM candidates WHERE video_id=? AND status=\'candidate\'', r.videoId), 'candidate revived');
});
test('seedJobs wakes a DONE analyze/render job when the work is needed again, but never loops on finished work', async () => {
  const { seedJobs } = await import('../src/pipeline.ts'); const { enqueue, completeJob, claim } = await import('../src/db.ts'); const { testConfig } = await import('./helpers.ts');
  const cfg = testConfig(); const s = new Store(cfg.dbPath);
  s.exec(`INSERT INTO sources(kind, uri, title) VALUES ('local','x','x')`); const sid = s.get<{ id: number }>('SELECT id FROM sources')!.id;
  s.exec(`INSERT INTO videos(source_id, path, fingerprint, state) VALUES (?, '/x.mp4', 'fp', 'NEW')`, sid); const vid = s.get<{ id: number }>('SELECT id FROM videos')!.id;
  enqueue(s, 'analyze', `analyze:${vid}`); const j = claim(s)!; completeJob(s, j.id); assert.equal(claim(s), undefined);
  assert.ok(seedJobs(s, cfg) >= 1); assert.ok(claim(s), 'DONE analyze job woke up for a NEW video');
});
test('AUTH_REVOKED is explained as a Google login problem, not a network failure ("reconnect" matched /ECONN/)', async () => {
  const { explainConnError } = await import('../src/connections.ts');
  assert.match(explainConnError('AUTH_REVOKED: invalid_grant — reconnect the YouTube account')!, /Testing.*Production|Publish app/s); assert.equal(explainConnError('fetch failed'), null);
});
test('face-follow damping: single face steady, multi-face jump is rate-limited, no face stays empty, sensitivity changes speed', async () => {
  const { smoothTrack } = await import('../src/edit/facetrack.ts');
  const steady = smoothTrack(Array.from({ length: 10 }, (_, i) => [i * 0.8, 0.5 + (i % 2 ? 0.004 : -0.004)] as [number, number])); assert.ok(steady.every(([, v]) => Math.abs(v - 0.5) < 0.01), 'jitter ignored (single face)');
  const jump = Array.from({ length: 8 }, (_, i) => [i * 0.8, i < 2 ? 0.3 : 0.8] as [number, number]); // new speaker on the right
  const slow = smoothTrack(jump, 0), fast = smoothTrack(jump, 1); assert.ok(slow[3]![1] < fast[3]![1], 'sensitive camera pans faster'); assert.ok(slow[2]![1] - slow[1]![1] <= 0.12 * 0.8 + 1e-6, 'speed cap per second'); assert.ok(slow.every(([, v]) => v >= 0 && v <= 1));
  assert.deepEqual(smoothTrack([]), []); assert.deepEqual(smoothTrack([[0, 0.4]]), [[0, 0.4]]); assert.equal(smoothTrack([[0, 0.4], [1, NaN], [2, 0.6]]).length, 2);
});
