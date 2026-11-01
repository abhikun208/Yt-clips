import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localMetadata } from '../src/seo/local.ts';

const T = 'Bhai ye trick koi nahi batata, secret hai. Aur phir achanak sab kuch badal gaya, ye dekho kya hua. Kya baat hai, mazaa aa gaya yaar. Dekho ye kitna zabardast hai wow';
test('metadata: Roman Hinglish text gets Roman templates (no Devanagari template around a Roman keyword), real speech wins, junk verbs are not keywords', () => {
  const m = localMetadata({ transcript: T, category: 'funny', language: 'hi', hook: 'Bhai ye trick koi nahi batata, secret hai', hashtags: ['#Shorts'] });
  for (const t of m.titles) assert.ok(!/[ऀ-ॿ]/.test(t) || !/[A-Za-z]{3}/.test(t), 'mixed script title: ' + t);
  assert.ok(!/Ka Sach|Ke Baare|का सच/.test(m.title), m.title); assert.ok(!m.keyphrases.some((k) => /^(gaya|baat|dekho)$/.test(k)), m.keyphrases.join());
  const d = localMetadata({ transcript: 'सच बोलूं तो ये बहुत खतरनाक था और फिर उसने जो किया वो अविश्वसनीय था दोस्तों', category: 'shock', language: 'hi', hashtags: [] });
  assert.ok(/[ऀ-ॿ]/.test(d.title));
});

import { textInRange } from '../src/analysis/transcript.ts';
test('textInRange: a pause between unpunctuated cues becomes a sentence break; continuous speech stays joined', () => {
  const cues = [{ start: 0, end: 2, text: 'pehli baat' }, { start: 2.1, end: 4, text: 'jaari hai' }, { start: 5, end: 7, text: 'doosri baat!' }, { start: 7.5, end: 9, text: 'teesri' }];
  assert.equal(textInRange(cues, 0, 10), 'pehli baat jaari hai. doosri baat! teesri');
});
