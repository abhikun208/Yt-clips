import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHinglish, hasDevanagari } from '../src/ai/hinglish.ts';
import { applyCaptionLanguage } from '../src/ai/translate.ts';

test('toHinglish romanises Devanagari, keeps Latin', () => {
  assert.equal(toHinglish('यह क्या हो रहा है भाई'), 'yah kya ho raha hai bhai');
  assert.equal(toHinglish('Booyah भाई!'), 'Booyah bhai!');
  assert.ok(!hasDevanagari(toHinglish('मैं आज बहुत बड़ा क्लच जीता')));
});
test('applyCaptionLanguage: Devanagari → Hinglish with no LLM, timing kept', async () => {
  const cues = [{ start: 1, end: 2.5, text: 'यह क्या हो रहा है' }];
  const r = await applyCaptionLanguage(cues, 'auto', 'hi', []);
  assert.equal(r.cues[0]!.start, 1); assert.equal(r.cues[0]!.end, 2.5); assert.equal(r.cues[0]!.text, 'yah kya ho raha hai'); assert.match(r.used ?? '', /rule/);
});
test('applyCaptionLanguage: original / English channel untouched; English→Hinglish via LLM', async () => {
  const en = [{ start: 0, end: 2, text: 'that was an amazing clutch' }];
  assert.deepEqual((await applyCaptionLanguage(en, 'original', 'hi', [])).cues, en);
  assert.deepEqual((await applyCaptionLanguage(en, 'auto', 'en', [])).cues, en);
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"lines":["kya zabardast clutch tha bhai"]}' } }] }))) as unknown as typeof fetch;
  const r = await applyCaptionLanguage(en, 'hinglish', 'hi', [{ baseUrl: 'http://x', apiKey: 'k', model: 'm' }], f);
  assert.equal(r.cues[0]!.text, 'kya zabardast clutch tha bhai'); assert.equal(r.cues[0]!.end, 2);
});
