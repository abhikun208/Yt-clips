import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSilence, parseScenes, parseEnergy, normalizeEnergy } from '../src/analysis/signals.ts';
import { detectBoundaries } from '../src/analysis/boundaries.ts';
import { selectCandidates, overlapRatio } from '../src/analysis/select.ts';
import { parseSubtitles, guessLanguage } from '../src/analysis/transcript.ts';
import { scoreText } from '../src/analysis/keywords.ts';

test('parsers handle ffmpeg output and empty/garbage', () => {
  assert.deepEqual(parseSilence('[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 3.25 | silence_duration: 1.75'), [{ start: 1.5, end: 3.25 }]);
  assert.deepEqual(parseSilence('garbage'), []);
  assert.deepEqual(parseScenes('lavfi.scd.time: 4.5\nlavfi.scd.time: 2.0'), [2, 4.5]);
  assert.deepEqual(parseEnergy('lavfi.astats.Overall.RMS_level=-20.5\nlavfi.astats.Overall.RMS_level=-inf', 0.5).values, [-20.5, -90]);
  assert.equal(normalizeEnergy({ step: 1, values: [-20] }).every((x) => x === 0), true, 'too little data -> zeros, no crash');
});

test('boundaries: detects intro/outro, honours override, caps absurd discards', () => {
  const b = detectBoundaries(100, { silence: [], black: [{ start: 0, end: 6 }, { start: 94, end: 100 }], scenes: [], introMaxSec: 30, outroMaxSec: 30 });
  assert.equal(b.introEnd, 6); assert.equal(b.outroStart, 94);
  assert.equal(detectBoundaries(100, { silence: [], black: [], scenes: [], introMaxSec: 30, outroMaxSec: 30 }).introEnd, 0, 'no evidence -> no cut (not a fixed number of seconds)');
  assert.equal(detectBoundaries(100, { silence: [], black: [], scenes: [], introMaxSec: 30, outroMaxSec: 30, override: { introEnd: 12 } }).introEnd, 12);
  assert.equal(detectBoundaries(100, { silence: [], black: [{ start: 0, end: 29 }], scenes: [], introMaxSec: 30, outroMaxSec: 30, override: { introEnd: 60 } }).introEnd, 0, 'cap >40%');
});

const P = { minSec: 10, maxSec: 30, targetSec: 20, maxClips: 5, minScore: 0.2, maxOverlap: 0.2 };
test('selector covers the FULL timeline (late moments are found), no overlaps, respects usable window', () => {
  const step = 0.5; const dur = 300;
  const energy = Array.from({ length: dur / step }, (_, i) => { const t = i * step; return t > 230 && t < 255 ? 0.95 : 0.35; });
  const c = selectCandidates({ videoKey: 'v', duration: dur, introEnd: 20, outroStart: 280, energy, energyStep: step, scenes: [], silence: [], cues: [] }, P);
  assert.ok(c.length > 0);
  assert.ok(c.some((x) => x.start >= 220 && x.end <= 270), 'late high-energy moment must be selected');
  for (const x of c) { assert.ok(x.start >= 20 && x.end <= 280, 'within usable window'); assert.ok(x.duration >= P.minSec && x.duration <= P.maxSec + 0.01); }
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) assert.ok(overlapRatio([c[i]!.start, c[i]!.end], [c[j]!.start, c[j]!.end]) <= P.maxOverlap);
});

test('selector: silent/flat content yields no filler clips; too-short window yields none', () => {
  const flat = selectCandidates({ videoKey: 'v', duration: 100, introEnd: 0, outroStart: 100, energy: Array(200).fill(0), energyStep: 0.5, scenes: [], silence: [{ start: 0, end: 100 }], cues: [] }, P);
  assert.equal(flat.length, 0);
  assert.equal(selectCandidates({ videoKey: 'v', duration: 8, introEnd: 0, outroStart: 8, energy: [], energyStep: 0.5, scenes: [], silence: [], cues: [] }, P).length, 0);
});

test('candidate fingerprints are stable across runs (dedup)', () => {
  const inp = { videoKey: 'v9', duration: 120, introEnd: 0, outroStart: 120, energy: Array.from({ length: 240 }, (_, i) => (i % 40 < 20 ? 0.9 : 0.3)), energyStep: 0.5, scenes: [], silence: [], cues: [] };
  const a = selectCandidates(inp, P), b = selectCandidates(inp, P);
  assert.deepEqual(a.map((x) => x.fingerprint), b.map((x) => x.fingerprint));
});

test('transcript: SRT/VTT parse, bad cues skipped, language guess, keyword/emotion signal', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:03,500\nSecret hai yaar\n\n2\nbad\n\n3\n00:00:05.000 --> 00:00:04.000\nreversed');
  assert.equal(cues.length, 1); assert.equal(cues[0]!.end, 3.5);
  assert.equal(guessLanguage('यह क्या है'), 'hi'); assert.equal(guessLanguage('kya hai ye yaar nahi aur'), 'hinglish'); assert.equal(guessLanguage(''), 'unknown');
  assert.equal(scoreText('haha so funny').emotion, 'funny'); assert.ok(scoreText('subscribe karo like share').filler > 0);
});
