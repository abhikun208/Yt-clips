import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHinglish, hasDevanagari } from '../src/ai/hinglish.ts';
import { applyCaptionLanguage } from '../src/ai/translate.ts';

test('toHinglish romanises Devanagari, keeps Latin', () => {
  assert.equal(toHinglish('यह क्या हो रहा है भाई'), 'yeh kya ho raha hai bhai');
  assert.equal(toHinglish('Booyah भाई!'), 'Booyah bhai!');
  assert.ok(!hasDevanagari(toHinglish('मैं आज बहुत बड़ा क्लच जीता')));
});
test('applyCaptionLanguage: Devanagari → Hinglish with no LLM, timing kept', async () => {
  const cues = [{ start: 1, end: 2.5, text: 'यह क्या हो रहा है' }];
  const r = await applyCaptionLanguage(cues, 'auto', 'hi', []);
  assert.equal(r.cues[0]!.start, 1); assert.equal(r.cues[0]!.end, 2.5); assert.equal(r.cues[0]!.text, 'yeh kya ho raha hai'); assert.match(r.used ?? '', /rule/);
});
test('applyCaptionLanguage: original / English channel untouched; English→Hinglish via LLM', async () => {
  const en = [{ start: 0, end: 2, text: 'that was an amazing clutch' }];
  assert.deepEqual((await applyCaptionLanguage(en, 'original', 'hi', [])).cues, en);
  assert.deepEqual((await applyCaptionLanguage(en, 'auto', 'en', [])).cues, en);
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"lines":["kya zabardast clutch tha bhai"]}' } }] }))) as unknown as typeof fetch;
  const r = await applyCaptionLanguage(en, 'hinglish', 'hi', [{ baseUrl: 'http://x', apiKey: 'k', model: 'm' }], f);
  assert.equal(r.cues[0]!.text, 'kya zabardast clutch tha bhai'); assert.equal(r.cues[0]!.end, 2);
});

test('on-screen hook title is romanised like the captions (no Devanagari title above Roman captions)', async () => {
  const { toHinglish, hasDevanagari } = await import('../src/ai/hinglish.ts');
  const t = toHinglish('सच बोलूं तो ये बहुत खतरनाक था'); assert.equal(hasDevanagari(t), false); assert.ok(t.length > 10);
});

test('Hinglish spelling: long vowels, schwa deletion, loanwords, as people type them', async () => {
  const { toHinglish } = await import('../src/ai/hinglish.ts');
  const t = (a: string, b: string) => assert.equal(toHinglish(a), b);
  t('मैं आज आपको बताने वाला हूँ', 'main aaj aapko batane wala hu');
  t('यह कैसे काम करता है', 'yeh kaise kaam karta hai');
  t('यह वीडियो ज़रूर देखना', 'yeh video zaroor dekhna');
  t('पैसा कमाना आसान नहीं होता दोस्तों', 'paisa kamana aasan nahi hota doston');
  t('क्योंकि वो मेरी बात नहीं मानता', 'kyunki wo meri baat nahi maanta');
});
test('Devanagari captions keep per-word timing after romanisation (karaoke stays in sync) and need no LLM key', async () => {
  const { applyCaptionLanguage } = await import('../src/ai/translate.ts');
  const cues = [{ start: 0, end: 2, text: 'आप काम करो', words: [{ start: 0, end: 0.6, text: 'आप' }, { start: 0.7, end: 1.2, text: 'काम' }, { start: 1.3, end: 2, text: 'करो' }] }];
  const r = await applyCaptionLanguage(cues, 'auto', 'hi', []);
  assert.equal(r.cues[0]!.text, 'aap kaam karo'); assert.deepEqual(r.cues[0]!.words!.map((w) => w.text), ['aap', 'kaam', 'karo']); assert.equal(r.cues[0]!.words![1]!.start, 0.7);
});
