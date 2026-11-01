import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moodFromFace, applyFaceMood, type FaceMood } from '../src/analysis/facemood.ts';
import { lookup, fingerprint, musicRisk, type Fetcher } from '../src/media/acoustid.ts';
import { tmp, makeVideo } from './capcut_helpers.ts';

const f = (o: Partial<FaceMood>): FaceMood => ({ faces: 5, samples: 6, smile: 0, surprise: 0, sad: 0, anger: 0, ...o });
test('face mood: smile boosts and relabels generic clips only; weak/absent faces change nothing', () => {
  const a = moodFromFace(f({ smile: 0.6 }), { category: 'dialogue', score: 0.5 }); assert.equal(a.category, 'happy'); assert.ok(a.score > 0.5 && a.score <= 0.55);
  assert.equal(moodFromFace(f({ smile: 0.6 }), { category: 'funny', score: 0.5 }).category, 'funny');
  assert.equal(moodFromFace(f({ surprise: 0.7 }), { category: 'general', score: 0.5 }).category, 'shock');
  assert.equal(moodFromFace(f({ smile: 0.9, faces: 1 }), { category: 'general', score: 0.5 }).label, null);
  assert.equal(moodFromFace({ ...f({}), error: 'x' }, { category: 'general', score: 0.5 }).label, null);
});
test('applyFaceMood: stops at the first environment error, tags used candidates', async () => {
  const mk = (s: number) => ({ start: s, end: s + 20, duration: 20, score: 0.5, category: 'dialogue', reason: 'r', hook: '', transcript: '', language: 'hi', confidence: 1, signals: {} });
  let calls = 0; const bad = await applyFaceMood([mk(0), mk(30)], 'v.mp4', async () => { calls++; return { error: 'model_unavailable' }; }); assert.equal(calls, 1); assert.equal(bad.used, 0); assert.match(bad.note!, /model_unavailable/);
  const ok = await applyFaceMood([mk(0), mk(30)], 'v.mp4', async (_v, a) => (a === 0 ? f({ smile: 0.7 }) : f({})) ); assert.equal(ok.used, 1); assert.equal(ok.cands[0]!.category, 'happy'); assert.match(ok.cands[0]!.reason, /smiling/);
});
test('chromaprint fingerprint works through ffmpeg; AcoustID lookup parsed (fake server), failures are quiet', async () => {
  const r = tmp(); const v = makeVideo(r); const fp = await fingerprint(v, 30); assert.ok(fp && fp.fp.length > 10 && fp.duration >= 5);
  let seen = ''; const fake: Fetcher = async (_u, init) => { seen = init.body; return { ok: true, status: 200, json: async () => ({ status: 'ok', results: [{ score: 0.2, recordings: [{ id: 'low', title: 'Low' }] }, { score: 0.97, recordings: [{ id: 'abc', title: 'Some Song', artists: [{ name: 'A' }, { name: 'B' }] }] }] }) }; };
  const m = await lookup('KEY', fp!, fake); assert.equal(m!.title, 'Some Song'); assert.equal(m!.artist, 'A, B'); assert.ok(seen.includes('client=KEY') && seen.includes('meta=recordings'));
  assert.equal(await lookup('K', fp!, async () => ({ ok: false, status: 500, json: async () => ({}) })), null); assert.equal(await lookup('K', fp!, async () => { throw new Error('net'); }), null);
  assert.equal(await lookup('K', fp!, async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', results: [{ score: 0.9 }] }) })), null);
  assert.equal(await musicRisk('/x/a.mp3', 'K', 0.85, fake, async () => fp), (await musicRisk('/x/a.mp3', 'K', 0.85, fake, async () => fp)));
  assert.equal((await musicRisk('/x/b.mp3', 'K', 0.99, fake, async () => fp)), null);
});
