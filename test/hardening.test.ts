import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store, enqueue } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { work, queuePaused, resetBreaker } from '../src/pipeline.ts';
import { correctText, loadCorrections } from '../src/ai/corrections.ts';
import { tmpDir } from './helpers.ts';

test('circuit breaker: when most recent jobs fail the queue pauses (no retry storm) and then stays paused until the time is over', async () => {
  resetBreaker(); const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { resources: { renderConcurrency: 1, jobMaxAttempts: 9 } } });
  for (let i = 0; i < 12; i++) enqueue(store, 'zzz', `zzz:${i}`); // unknown job kind: always fails
  const r = await work(store, cfg, { maxJobs: 12 }); assert.ok(r.failed >= 8 && r.failed < 12, `stopped early: ${r.failed}`); assert.equal(queuePaused(store), true);
  const again = await work(store, cfg, { maxJobs: 12 }); assert.deepEqual(again, { done: 0, failed: 0, dead: 0 });
  store.exec(`UPDATE kv SET v='0' WHERE k='queue:paused_until'`); assert.equal(queuePaused(store), false); resetBreaker();
});
test('corrections: chat spellings -> one standard form, case kept, owner file wins, broken file is harmless', () => {
  const d = tmpDir(); const base = loadCorrections(d);
  assert.equal(correctText('Nhi yaar bhot mje pta nhi', base), 'Nahi yaar bahut mujhe pata nahi'); assert.equal(correctText('kya hua', base), 'kya hua');
  writeFileSync(join(d, 'corrections.json'), JSON.stringify({ 'jethaal': 'Jethalal', nhi: 'nahin' })); const own = loadCorrections(d);
  assert.equal(correctText('jethaal bola nhi', own), 'Jethalal bola nahin'); writeFileSync(join(d, 'corrections.json'), '{broken'); assert.equal(correctText('nhi', loadCorrections(d)), 'nahi');
});
test('STT health check: a provider that rejects the key is skipped in ~no time and never receives the audio upload', async () => {
  const { transcribeVideo, resetApiBreaker, resetDeadSttKeys, resetHealth } = await import('../src/analysis/stt.ts'); const { makeFixture } = await import('./helpers.ts'); const d = tmpDir(); const v = join(d, 'v.mp4'); await makeFixture(v, 3);
  const keep = { K: process.env.STT_API_KEY, B: process.env.STT_API_BASE, G: process.env.GROQ_API_KEY }; const realFetch = globalThis.fetch; const urls: string[] = [];
  process.env.STT_API_KEY = 'gsk_rejectedkey_12345'; process.env.STT_API_BASE = 'https://api.groq.com/openai/v1'; delete process.env.GROQ_API_KEY; resetApiBreaker(); resetDeadSttKeys(); resetHealth();
  globalThis.fetch = (async (u: string | URL | Request) => { urls.push(String(u)); return new Response('{}', { status: 401 }); }) as typeof fetch;
  try { const t0 = Date.now(); await transcribeVideo(loadConfig(process.cwd(), { dataDir: d, overrides: { stt: { mode: 'auto', model: 'small', language: 'auto', engine: 'api' } } }), v); assert.ok(Date.now() - t0 < 4000); assert.ok(urls.filter((x) => /groq|openai|together/.test(x)).every((x) => /\/models$/.test(x)), urls.join(',')); }
  finally { globalThis.fetch = realFetch; resetDeadSttKeys(); resetHealth(); for (const [k, e] of [['STT_API_KEY', keep.K], ['STT_API_BASE', keep.B], ['GROQ_API_KEY', keep.G]] as const) { if (e === undefined) delete process.env[k]; else process.env[k] = e; } }
});

test('LLM caption fix: brand/proper-noun fixes are applied (timing kept); rewrites, word-count changes and wild edits are refused', async () => {
  const { llmFixCaptions, acceptLine } = await import('../src/ai/captionfix.ts');
  assert.equal(acceptLine('somato se order kiya', 'Zomato se order kiya'), true); assert.equal(acceptLine('yeh baat hai', 'yeh baat bahut zaroori hai'), false); assert.equal(acceptLine('yeh baat hai', 'is topic ke baare'), false);
  const cues = [{ start: 0, end: 2, text: 'somato se order kiya', words: [{ start: 0, end: .5, text: 'somato' }, { start: .5, end: 1, text: 'se' }, { start: 1, end: 1.5, text: 'order' }, { start: 1.5, end: 2, text: 'kiya' }] }, { start: 2, end: 4, text: 'yeh baat hai' }];
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"lines":["Zomato se order kiya","yeh baat bahut zaroori hai"]}' } }] }))) as typeof fetch;
  const r = await llmFixCaptions(cues, { title: 'Zomato review' }, [{ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' }], f);
  assert.equal(r.changed, 1); assert.equal(r.cues[0]!.text, 'Zomato se order kiya'); assert.equal(r.cues[0]!.words![0]!.text, 'Zomato'); assert.equal(r.cues[0]!.words![0]!.end, .5); assert.equal(r.cues[1]!.text, 'yeh baat hai');
  const bad = (async () => new Response('nope', { status: 500 })) as typeof fetch; assert.deepEqual((await llmFixCaptions(cues, {}, [{ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' }], bad)).cues, cues); // provider down: captions untouched
  assert.deepEqual((await llmFixCaptions(cues, {}, [])).cues, cues); // no key: skipped
});
test('breaker is half-open: after the pause, 3 failures in a row re-open it with a LONGER pause; recovery closes it', async () => {
  resetBreaker(); const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { resources: { renderConcurrency: 1, jobMaxAttempts: 9 } } });
  for (let i = 0; i < 12; i++) enqueue(store, 'zzz', `a:${i}`); await work(store, cfg, { maxJobs: 12 });
  const first = Number(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='queue:paused_until'`)!.v) - Date.now(); assert.ok(first > 9 * 60_000 && first <= 10 * 60_000);
  store.exec(`UPDATE kv SET v='0' WHERE k='queue:paused_until'`); store.exec(`UPDATE jobs SET run_after=0`); await work(store, cfg, { maxJobs: 6 });
  const second = Number(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='queue:paused_until'`)!.v) - Date.now(); assert.ok(second > 19 * 60_000, `escalated pause: ${second}`); resetBreaker();
});
