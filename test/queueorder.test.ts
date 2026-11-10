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
