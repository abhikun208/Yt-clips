import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSeries } from '../src/analysis/series.ts';
import { realHook } from '../src/seo/hook.ts';
import { buildMetadata, withPart } from '../src/seo/metadata.ts';
import { Store } from '../src/db.ts';

const sents = Array.from({ length: 30 }, (_, i) => ({ start: i * 6, end: i * 6 + 5.5, text: `Yeh sentence number ${i} hai bhai` }));
const P = { minSec: 15, maxSec: 60, partSec: 45, maxParts: 4, hi: 400 };

test('planSeries: long story splits on sentence ends', () => {
  const sp = planSeries(0, 59.5, sents, P)!;
  assert.ok(sp && sp.length >= 2);
  for (const s of sp) assert.ok(s.end - s.start >= 15 && s.end - s.start <= 66);
  for (let i = 1; i < sp.length; i++) assert.ok(Math.abs(sp[i]!.start - sp[i - 1]!.end) < 0.01);
});
test('planSeries: short story stays single', () => {
  assert.equal(planSeries(0, 30, sents.slice(0, 6), P), null);
});
test('realHook: real short sentence, null if too short', () => {
  const h = realHook('Aaj maine ek bahut bada clutch jeeta yaar. Phir sab hans pade aur game khatam hua.');
  assert.ok(h && h.split(/\s+/).length <= 8 && !/#/.test(h));
  assert.equal(realHook('haan ok'), null);
});
test('no transcript: no invented hype title', () => {
  const m = buildMetadata({ transcript: '', category: 'x', language: 'en', sourceTitle: 'My Stream', channelName: 'Ch' });
  assert.ok(!/Josh|🔥/.test(m.title)); assert.ok(m.warnings.length > 0);
});
test('withPart adds Part n/N', () => {
  const m = withPart(buildMetadata({ transcript: '', category: 'x', language: 'en', sourceTitle: 'S' }), { no: 1, total: 3 });
  assert.match(m.title, /Part 1\/3/); assert.match(m.description, /Part 1\/3/);
});
test('migration v8 columns exist', () => {
  const st = new Store(':memory:');
  const cols = st.all<{ name: string }>(`PRAGMA table_info(candidates)`).map((c: { name: string }) => c.name);
  for (const c of ['part_no', 'part_total', 'series_key']) assert.ok(cols.includes(c));
});

import { chooseCuts, scoreCut } from '../src/analysis/splitter.ts';
test('narrative split: cuts at the cliffhanger/pause, not at a dangling word, even when equal time says otherwise', () => {
  const T = (s: number, e: number, text: string) => ({ start: s, end: e, text });
  const sents = [T(0, 9, 'Ek aadmi raat ko ghar aaya.'), T(9.1, 19, 'Usne darwaza khola aur'), T(19.1, 29, 'andar kuch tha. Lekin tabhi...'), T(31, 40, 'Light chali gayi.'), T(40.1, 50, 'Phir awaaz aayi.'), T(50.1, 60, 'Aur sab khatam.')];
  assert.ok(scoreCut(2, sents).score > scoreCut(1, sents).score, 'cliffhanger + pause beats dangling word');
  const r = chooseCuts(0, 60, 2, sents, { minSec: 15, maxSec: 45 })!; assert.equal(r.cuts[0], 29); assert.match(r.reasons[0]!, /open ending/);
});
