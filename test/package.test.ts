import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPack, toHashtag, isJunkPhrase, fitTags } from '../src/seo/expand.ts';
import { buildMetadata, validateMetadata } from '../src/seo/metadata.ts';
import { llmMetadata, looksEnglish } from '../src/seo/llm.ts';
import { buildStyledAss } from '../src/edit/captions.ts';
import { normSpeed, buildVideoGraph, buildAudioGraph } from '../src/edit/filters.ts';

const SUG = (q: string) => JSON.stringify([q, Array.from({ length: 10 }, (_, i) => `${q} ${['train', 'video', 'news', 'live', 'today', 'kahani', 'status', 'song', 'review', 'scene'][i]}`)]);
const fakeSuggest = (async (u: string) => ({ ok: true, text: async () => SUG(decodeURIComponent(/[?&]q=([^&]*)/.exec(u)![1]!)) })) as unknown as typeof fetch;

test('junk words never become hashtags/keywords (owner log: #bees #bhai #gaya #unnisbees)', () => {
  for (const w of ['bees', 'bhai', 'gaya', 'unnisbees', 'sabko', 'the']) assert.equal(toHashtag(w), null, w);
  assert.equal(toHashtag('mumbai local train'), '#MumbaiLocalTrain'); assert.ok(isJunkPhrase('bhai gaya sabko'));
  const m = buildMetadata({ transcript: 'bees bhai gaya sabko unnis bees bhai gaya sabko mumbai local train mumbai local train bhai gaya delay ho gayi', category: 'general', language: 'hinglish' });
  const all = [...m.hashtags, ...m.keywords, ...m.tags].join(' ').toLowerCase(); assert.doesNotMatch(all, /#?\b(bees|bhai|gaya|sabko)\b/);
});

test('buildPack: 50 keywords, tags <=500 chars, 50 hashtags, 10 highlights, all from the video + real search phrases', async () => {
  const p = await buildPack(null, { seeds: ['mumbai local', 'train delay', 'platform bheed', 'ticket counter', 'monsoon', 'station'], aiTags: ['local train', 'bhai gaya'], highlights: Array.from({ length: 14 }, (_, i) => `moment ${i}`), lang: 'hinglish', fetchFn: fakeSuggest });
  assert.equal(p.keywords.length, 50); assert.ok(p.hashtags.length >= 40 && p.hashtags.length <= 50 && p.hashtags[0] === '#Shorts'); assert.equal(p.highlights.length, 10);
  assert.ok(p.tags.join(',').length <= 500 && p.tags.length >= 20); assert.ok(!p.keywords.includes('bhai gaya')); assert.ok(p.keywords.some((k) => /^mumbai local /.test(k)));
  assert.deepEqual(fitTags(['a'.repeat(300), 'b'.repeat(300), 'cc dd']), ['a'.repeat(300), 'cc dd']);
});

test('description: Roman Hinglish enforced (English about is rewritten), 15 real hashtags max, validate passes', async () => {
  assert.ok(looksEnglish('The man jumps into the water and then he is saved by the crowd')); assert.ok(!looksEnglish('Is clip mein bhai ne kamaal kar diya aur sab hans pade'));
  const base = buildMetadata({ transcript: 'mumbai local train mein bahut bheed thi aur sab log ek doosre ko dhakka de rahe the station par mumbai local', category: 'general', language: 'hinglish' });
  let n = 0;
  const f = (async (_u: string, init: { body: string }) => { n++; const b = JSON.parse(init.body).messages[0].content as string;
    const content = /Rewrite each line/.test(b) ? JSON.stringify(['Is clip mein local train ki bheed dikhi, sab dhakka de rahe the.', 'Bheed ka scene', 'Station ka haal']) : JSON.stringify({ title: 'Mumbai local ki bheed 😱', titles: ['a b c', 'd e f'], about: 'A crowd pushes inside the local train at the station and nobody can move.', highlights: ['The crowd grows', 'Everyone pushes'], tags: ['mumbai local', 'train bheed'], hashtags: ['MumbaiLocal', 'bhai'], searches: ['mumbai local bheed'], thumbnailText: 'BHEED' });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content } }] }) }; }) as unknown as typeof fetch;
  const r = await llmMetadata(base, 'mumbai local train mein bahut bheed thi', { baseUrl: 'http://x', apiKey: '', model: 'm' }, f);
  assert.equal(r.source, 'llm'); assert.match(r.description, /Is clip mein local train ki bheed/); assert.doesNotMatch(r.description, /A crowd pushes/); assert.equal(n, 2);
  assert.ok(r.warnings.some((w) => /Roman Hinglish/.test(w))); assert.deepEqual(validateMetadata(r), []);
});

test('title strip: full-length box + text, white/black, CTA moved under it; off keeps the old pop-in', () => {
  const cues = [{ start: 0, end: 8, text: 'hello bhai kaise ho aap sab log' }];
  const k = buildStyledAss(cues, 0, 8, 'Mumbai local ki bheed', { width: 1080, height: 1920, titleBar: 'black', cta: 'SUBSCRIBE' }).ass;
  assert.match(k, /Dialogue: 0,0:00:00\.00,0:00:08\.00,Title,,0,0,0,,\{\\an7\\pos\(0,0\)\\p1.*\\1c&H000000&/); assert.match(k, /\\1c&H00FFFFFF&\}.*Mumbai local/); assert.doesNotMatch(k, /\\fscx80/);
  const w = buildStyledAss(cues, 0, 8, 'Mumbai local ki bheed', { width: 1080, height: 1920, titleBar: 'white' }).ass; assert.match(w, /\\1c&HFFFFFF&/); assert.match(w, /\\1c&H00000000&\}.*Mumbai/);
  assert.match(buildStyledAss(cues, 0, 8, 'Mumbai local', { width: 1080, height: 1920, titleBar: 'off' }).ass, /\\fscx80/);
});

test('speed: only 1.05..1.10 (or 1); applied after captions, audio atempo, ranges rejected', () => {
  assert.equal(normSpeed(1.07), 1.07); assert.equal(normSpeed('1.1'), 1.1); for (const x of ['5-7', 1.5, 7, undefined, null, 'x']) assert.equal(normSpeed(x), 1);
  const v = buildVideoGraph({ speed: 1.08, inW: 1920, inH: 1080, outW: 1080, outH: 1920, fps: 30, duration: 5, mood: 'general', reframe: 'crop', zoom: false, glow: false, fade: false, assPath: '/x.ass' } as never).graph;
  assert.match(v, /subtitles=.*;?.*setpts=PTS\/1\.08/s); assert.ok(v.indexOf('subtitles=') < v.indexOf('setpts=PTS/1.08'));
  assert.match(buildAudioGraph({ speed: 1.08, hasAudio: true, targetLufs: -14, duration: 5 }).graph!, /atempo=1\.08\[aout\]/);
  assert.doesNotMatch(buildVideoGraph({ inW: 1920, inH: 1080, outW: 1080, outH: 1920, fps: 30, duration: 5, mood: 'general', reframe: 'crop', zoom: false, glow: false, fade: false } as never).graph, /setpts=PTS\//);
});

test('render: speed 1.08 shortens the clip by exactly that factor, QC still passes, title strip burned in', async () => {
  const { Store } = await import('../src/db.ts'); const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts');
  const { renderCandidate } = await import('../src/edit/render.ts'); const { probe } = await import('../src/media/probe.ts'); const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 1, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'spd.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!;
  const base = await renderCandidate(s, cfg, cand.id, { zoom: false, glow: false, jumpCuts: false, speedRamp: false, speed: 1, titleBar: 'off', variant: 1 });
  const fast = await renderCandidate(s, cfg, cand.id, { zoom: false, glow: false, jumpCuts: false, speedRamp: false, speed: 1.08, titleBar: 'black', title: 'Mumbai local ki bheed', variant: 2 });
  const a = await probe(base.editedPath), b = await probe(fast.editedPath);
  assert.ok(Math.abs(b.duration - a.duration / 1.08) < 0.25, `${a.duration} -> ${b.duration}`); assert.ok(fast.qcPass, 'QC must pass at 1.08x');
});

test('finish pass: clip rendered without title gets the AI title strip in one light pass (audio copied, QC ok); hook fallback; not twice', async () => {
  const { Store } = await import('../src/db.ts'); const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts');
  const { renderCandidate } = await import('../src/edit/render.ts'); const { finishClip, screenTitle } = await import('../src/edit/retitle.ts'); const { probe } = await import('../src/media/probe.ts');
  const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path'); const { readFileSync } = await import('node:fs');
  assert.equal(screenTitle('Mumbai local ki bheed 😱 #Shorts'), 'Mumbai local ki bheed'); assert.equal(screenTitle('😱 #Shorts'), null); assert.ok(screenTitle('x '.repeat(60) + 'yy')!.length <= 64);
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 1, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast', titleBar: 'white' } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'fin.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!;
  const out = await renderCandidate(s, cfg, cand.id, { zoom: false, glow: false, jumpCuts: false, speedRamp: false, speed: 1 });
  const row = s.get<{ id: number; manifest_path: string }>('SELECT id, manifest_path FROM clips WHERE output_id=?', out.outputId)!;
  assert.ok(JSON.parse(readFileSync(row.manifest_path, 'utf8')).render.titleDeferred, 'title must be deferred on a fresh render');
  const before = await probe(out.editedPath);
  const f = await finishClip(s, cfg, row.id, 'Bike dhone ka mazedaar scene 😂 #Shorts'); assert.equal(f.ok, true, String(f.why)); assert.equal(f.title, 'Bike dhone ka mazedaar scene');
  const after = await probe(out.editedPath); assert.ok(Math.abs(after.duration - before.duration) < 0.3 && after.hasAudio === before.hasAudio);
  assert.equal(JSON.parse(readFileSync(row.manifest_path, 'utf8')).render.titleDeferred, null);
  assert.equal((await finishClip(s, cfg, row.id, 'Doosra title')).ok, false); // never printed twice
});

test('b-roll: plan slots, Pexels download via mocked API, no key = nothing', async () => {
  const { planBroll, fetchBroll } = await import('../src/edit/broll.ts'); const { tmpDir } = await import('./helpers.ts');
  assert.deepEqual(planBroll(6), []); const p = planBroll(15); assert.equal(p.length, 3); assert.ok(p[0]!.start >= 1.2 && p[2]!.end <= 15 - 1.2 && p.every((x, i) => i === 0 || x.start >= p[i - 1]!.end));
  const old = process.env.PEXELS_API_KEY; delete process.env.PEXELS_API_KEY; assert.deepEqual(await fetchBroll(tmpDir(), ['rain'], 3), []);
  process.env.PEXELS_API_KEY = 'k'; const calls: string[] = [];
  const f = (async (u: string, i?: { headers?: Record<string, string> }) => { calls.push(u); if (u.includes('api.pexels.com')) return { ok: true, json: async () => ({ videos: [{ id: 7, video_files: [{ link: 'https://v/x.mp4', width: 720, file_type: 'video/mp4' }, { link: 'https://v/big.mp4', width: 2160, file_type: 'video/mp4' }] }] }) }; return { ok: true, arrayBuffer: async () => new Uint8Array(20_000).buffer }; }) as unknown as typeof fetch;
  try { const files = await fetchBroll(tmpDir(), ['rainy street', 'train'], 1, f); assert.equal(files.length, 1); assert.ok(calls.some((c) => c === 'https://v/x.mp4')); } finally { if (old === undefined) delete process.env.PEXELS_API_KEY; else process.env.PEXELS_API_KEY = old; }
});

test('owner log 2026-11-13: AI answer with 20 hashtags is accepted (template "related" #tags no longer pushed the count over 15)', async () => {
  const tr = 'main hu Tanya Mittal aapki fevrit spirichval influensar aur main a rahi hu big basmen spirichval influensar'; const base = buildMetadata({ transcript: tr, category: 'general', language: 'hinglish' });
  const hs = Array.from({ length: 20 }, (_, i) => 'Tag' + String.fromCharCode(65 + i) + 'bc');
  const f = (async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: 'Tanya Mittal ki spiritual baatein', titles: ['x y z'], about: 'Is clip mein Tanya Mittal apne baare mein batati hain.', highlights: ['Tanya ka parichay'], tags: ['tanya mittal', 'bigg boss 19'], hashtags: hs, searches: ['tanya mittal'], thumbnailText: 'TANYA' }) } }] }) })) as unknown as typeof fetch;
  const r = await llmMetadata({ ...base, sourceTitle: 'Triggered insaan on Tanya' }, tr, { baseUrl: 'http://x', apiKey: '', model: 'm' }, f); assert.equal(r.source, 'llm'); assert.deepEqual(validateMetadata(r), []);
});

test('source file name tags become real hints; filler like "best moments"/"main" is junk', async () => {
  const { sourceHints, cleanSourceTitle } = await import('../src/seo/clipmeta.ts');
  const h = sourceHints('Triggered insaan on Tanya _tanyamittal _bigboss19 _biggboss _comedy _reaction_720P_HD_.mp4'); assert.ok(h.includes('tanyamittal') && h.includes('bigboss19') && !h.includes('comedy') && !h.includes('mp4'));
  assert.equal(cleanSourceTitle('Triggered insaan _tanyamittal_720P_HD_.mp4'), 'Triggered insaan tanyamittal');
  assert.ok(isJunkPhrase('best moments') && isJunkPhrase('main hun'));
  const p = await buildPack(null, { seeds: ['best moments', 'main'], hints: ['tanyamittal', 'bigboss19'], aiTags: [], lang: 'hinglish', fetchFn: fakeSuggest });
  assert.ok(p.hashtags.includes('#Tanyamittal') && p.keywords.includes('tanyamittal') && !p.keywords.some((k) => /best moments/.test(k)));
});

test('pipeline passes the speech hook as a FALLBACK (opts.hook), so the title is still deferred until the AI has seen the clip', async () => {
  const { Store } = await import('../src/db.ts'); const { ingestLocal } = await import('../src/sources/local.ts'); const { analyzeVideo } = await import('../src/analysis/analyzer.ts');
  const { renderCandidate } = await import('../src/edit/render.ts'); const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts'); const { join } = await import('node:path'); const { readFileSync } = await import('node:fs');
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 1, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'hk.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!;
  const out = await renderCandidate(s, cfg, cand.id, { zoom: false, glow: false, jumpCuts: false, speedRamp: false, hook: 'main hu Tanya Mittal' });
  const row = s.get<{ manifest_path: string }>('SELECT manifest_path FROM clips WHERE output_id=?', out.outputId)!; const d = JSON.parse(readFileSync(row.manifest_path, 'utf8')).render;
  assert.equal(d.titleDeferred?.title, 'main hu Tanya Mittal'); assert.equal(d.titleBar, 'black'); assert.equal(d.speed, 1.05);
});

test('caption fix restores phonetic English words (fevrit -> favourite) but still refuses wild rewrites', async () => {
  const { llmFixCaptions } = await import('../src/ai/captionfix.ts');
  const f = (async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ lines: ['aapki favourite spiritual influencer', 'main hu sunita'] }) } }] }) })) as unknown as typeof fetch;
  const r = await llmFixCaptions([{ start: 0, end: 2, text: 'aapki fevrit spirichval influensar' }, { start: 2, end: 4, text: 'main hu Tanya' }], { title: 'Tanya Mittal' }, [{ baseUrl: 'http://x', apiKey: '', model: 'm' }] as never, f);
  assert.equal(r.cues[0]!.text, 'aapki favourite spiritual influencer'); assert.equal(r.cues[1]!.text, 'main hu Tanya');
});
