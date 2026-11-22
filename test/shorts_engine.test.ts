import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContent } from '../src/analysis/contentdetect.ts';
import { gateCandidates, similarity } from '../src/analysis/qualitygate.ts';
import { resolveContentProfile } from '../src/analysis/profiles.ts';
import type { Candidate } from '../src/analysis/select.ts';

const cand = (o: Partial<Candidate> & { transcript: string }): Candidate => ({ start: 0, end: 30, duration: 30, score: 0.6, category: 'general', reason: '', hook: '', language: 'en', confidence: 0.5, signals: { payoff: 0.6, hookLine: 0.5 }, ...o });

test('content detection: types + sub-types from English / Hinglish text; weak evidence stays general', () => {
  const g = detectContent('gameplay bro clutch 1v3 headshot squad wipe booyah', ''); assert.equal(g.profile, 'gaming'); assert.equal(g.subType, 'clutch');
  const p = detectContent("welcome back to the podcast, my guest today, let's have a conversation and a debate about this opinion"); assert.equal(p.profile, 'podcast');
  const v = detectContent('aaj hum trip pe hain, hotel airport beach vlog shuru'); assert.equal(v.profile, 'vlog'); assert.equal(v.subType, 'travel');
  const e = detectContent('how to learn this step by step tutorial, kaise karna hai samjho'); assert.equal(e.profile, 'educational'); assert.equal(e.subType, 'tutorial');
  assert.equal(detectContent('one stray word: match').profile, 'general'); assert.equal(detectContent('').confidence, 0);
});
test('auto profile resolves through detection; manual profile always wins', () => {
  assert.equal(resolveContentProfile('auto', "welcome back to the podcast, my guest today, a conversation and a debate"), 'podcast');
  assert.equal(resolveContentProfile('auto', 'nothing special here at all'), 'general');
  assert.equal(resolveContentProfile('vlog', 'gameplay clutch headshot booyah squad'), 'vlog');
});
test('quality gate: duplicate, repeated hook, missing context, bad boundary, borderline no-payoff — each dropped with a reason; strong clips kept', () => {
  const base = 'we tested the new phone for a whole week and the battery result honestly shocked everyone in the room today.';
  const good = cand({ start: 0, transcript: base, hook: 'the battery result shocked everyone', score: 0.9 });
  const dup = cand({ start: 100, transcript: base + ' really.', hook: 'something else entirely here friends', score: 0.7 });
  const rep = cand({ start: 200, transcript: 'a totally different long sentence about cooking pasta with lots of cheese and garlic tonight.', hook: 'the battery result shocked everyone', score: 0.65 });
  const ctx = cand({ start: 300, transcript: 'and because of that reason the whole thing fell apart in the end for everybody there.', score: 0.6 });
  const edge = cand({ start: 400, transcript: 'here is a completely new topic about gardening and soil quality and the way we water the', score: 0.6 });
  const weak = cand({ start: 500, transcript: 'random words about travelling to mountains with friends during the winter season again.', score: 0.4, signals: { payoff: 0.2, hookLine: 0 } });
  const r = gateCandidates([good, dup, rep, ctx, edge, weak], { minScore: 0.35 });
  assert.deepEqual(r.keep.map((c) => c.start), [0]); const why = Object.fromEntries(r.dropped.map((d) => [d.c.start, d.reason]));
  assert.deepEqual(why, { 100: 'duplicate', 200: 'repeated_hook', 300: 'missing_context', 400: 'bad_boundary', 500: 'weak_payoff' });
});
test('quality gate: 0 clips is valid, no-transcript clips and series parts are never gated, similarity is symmetric', () => {
  const none = gateCandidates([cand({ transcript: 'and then it ended abruptly with nothing else said here at all friends.' })], { minScore: 0.35 }); assert.equal(none.keep.length, 0);
  const silent = cand({ transcript: '' }); assert.equal(gateCandidates([silent], { minScore: 0.35 }).keep.length, 1);
  const part = cand({ transcript: 'and because of this part two continues the same story for a long while now.', fingerprint: 'p1' }); assert.equal(gateCandidates([part], { minScore: 0.35, skip: (c) => c.fingerprint === 'p1' }).keep.length, 1);
  assert.equal(similarity('a b c d e', 'a b c d e'), 1); assert.equal(similarity('a b c', 'x y z'), 0);
});

import { ungroundedClaims } from '../src/seo/grounding.ts';
test('grounding: numbers/names in a title must exist in the transcript or source title; no evidence never blocks', () => {
  const tx = 'today we tested the Samsung phone and it lasted 14 hours on one charge';
  assert.deepEqual(ungroundedClaims('Samsung phone lasted 14 hours #Shorts', tx), []);
  assert.deepEqual(ungroundedClaims('Samsung phone lasted 40 hours', tx), ['40']);
  assert.deepEqual(ungroundedClaims('This phone beat the Apple one', tx), ['Apple']);
  assert.deepEqual(ungroundedClaims('Wild claim 99%', ''), [], 'no transcript: cannot check, never blocks');
});
