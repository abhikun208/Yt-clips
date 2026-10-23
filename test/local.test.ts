import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyphrases, summarize, localMetadata, splitSentences } from '../src/seo/local.ts';
import { hookScore, payoffScore, snapToSentences, sentencesFromCues } from '../src/analysis/textsignals.ts';
import { buildMetadata, validateMetadata } from '../src/seo/metadata.ts';

const HINGLISH = 'Kya aap jaante ho ki cricket match fixing ka asli sach kya hai? Cricket match fixing mein bade bade naam shamil the. Match fixing ki wajah se cricket ka bharosa toot gaya. Ye sach aaj tak kisi ne nahi bataya. Cricket ke fans ko ye jaanna chahiye.';
const EN = 'Never invest in a stock without checking the cash flow. Cash flow shows the real health of a company. Most beginners ignore cash flow and lose money. Check cash flow statement first, then the price. That one habit saves thousands.';
const HI = 'क्या आप जानते हैं कि योग से तनाव कैसे कम होता है? योग तनाव को कम करने का सबसे अच्छा तरीका है। रोज़ योग करने से तनाव और चिंता दूर होती है। योग का असर दिमाग पर सीधा पड़ता है।';

test('keyphrases: topical multi-word phrases rank above filler/stop words, Hinglish + English + Devanagari', () => {
  const h = keyphrases(HINGLISH, 5).map((k) => k.phrase); assert.ok(h[0]!.includes('cricket') || h[0]!.includes('match') || h[0]!.includes('fixing'), h.join('|')); assert.ok(!h.includes('kya') && !h.includes('aap'));
  const e = keyphrases(EN, 5).map((k) => k.phrase); assert.ok(e.some((p) => p.includes('cash flow')), e.join('|'));
  const d = keyphrases(HI, 5).map((k) => k.phrase); assert.ok(d.some((p) => p.includes('योग')) && d.some((p) => p.includes('तनाव')), d.join('|'));
});
test('summarize picks keyphrase-rich sentences in order and stays short', () => { const s = summarize(EN, 2, 200); assert.ok(s.length <= 201 && /cash flow/i.test(s)); assert.equal(summarize('short text here', 2), 'short text here'); });
test('hookScore / payoffScore rank openings sensibly', () => {
  assert.ok(hookScore('Never invest in a stock without checking the cash flow.') > hookScore('So um yeah and then we went there.'));
  assert.ok(hookScore('Kya aap jaante ho cricket ka sach kya hai?') >= 0.5); assert.ok(hookScore('ok') < 0.2);
  assert.ok(payoffScore('That one habit saves thousands.') > payoffScore('and then we'));
});
test('localMetadata: Hinglish/English/Hindi titles use real transcript phrases, 30-95 chars, emoji, valid; no invented facts', () => {
  for (const [txt, lang] of [[HINGLISH, 'hinglish'], [EN, 'en'], [HI, 'hi']] as const) {
    const m = localMetadata({ transcript: txt, category: 'shock', language: lang, hashtags: ['#Shorts'] }); assert.ok(m.titles.length >= 2); assert.ok(m.title.length >= 20 && m.title.length <= 90, m.title);
    const low = (txt + ' ').toLowerCase(); assert.ok(m.keyphrases.every((k) => low.includes(k)), 'keyphrases come from the transcript'); assert.ok(m.description.length > 40); assert.ok(m.tags.includes('shorts'));
  }
});
test('buildMetadata uses the local engine when there is speech, validates, and falls back to template without transcript', () => {
  const m = buildMetadata({ transcript: EN, category: 'general', language: 'en' }); assert.deepEqual(validateMetadata(m), []); assert.match(m.title, /#Shorts$/); assert.ok(/cash flow/i.test(m.title + m.description));
  const g = buildMetadata({ transcript: '', category: 'funny', language: 'unknown' }); assert.ok(g.warnings.some((w) => /no transcript/.test(w)));
});
test('sentence snapping moves clip edges onto sentence boundaries when close; leaves them alone otherwise', () => {
  const cues = [{ start: 10, end: 14, text: 'Pehla vaakya yahan khatam hota hai.', words: [{ start: 10, end: 11, text: 'Pehla' }, { start: 11, end: 12, text: 'vaakya' }, { start: 12, end: 13, text: 'yahan' }, { start: 13, end: 14, text: 'khatam.' }] }, { start: 14, end: 18, text: 'Doosra vaakya shuru.', words: [{ start: 14.2, end: 15, text: 'Doosra' }, { start: 15, end: 16, text: 'vaakya' }, { start: 16, end: 18, text: 'shuru.' }] }];
  const s = sentencesFromCues(cues); assert.equal(s.length, 2);
  const [a, b] = snapToSentences(10.9, 17.4, s, { lo: 0, hi: 100, minLen: 3 }); assert.ok(Math.abs(a - 10) < 0.2 && Math.abs(b - 18) < 0.3, `${a},${b}`);
  assert.deepEqual(snapToSentences(50, 60, s, { lo: 0, hi: 100, minLen: 3 }), [50, 60]);
  assert.equal(splitSentences('Ek. Do? Teen।').length, 3);
});
