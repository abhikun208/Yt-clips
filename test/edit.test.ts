import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoGraph, reframeParts, buildAudioGraph, treatmentCoverage, DIMENSIONS, escFilterPath } from '../src/edit/filters.ts';
import { buildAss } from '../src/edit/ass.ts';
import { parseEbur128 } from '../src/edit/qc.ts';

const base = { inW: 1920, inH: 1080, outW: 1080, outH: 1920, fps: 30, duration: 20, mood: 'funny', reframe: 'crop' as const, zoom: true, glow: true, fade: true };

test('video graph: crop, fit_blur, already-vertical; treatments recorded truthfully', () => {
  const c = buildVideoGraph(base);
  assert.match(c.graph, /crop=w=/); assert.match(c.graph, /\[vout\]$/);
  assert.equal(c.treatments.find((t) => t.dimension === 'captions')!.applied, false, 'no transcript -> captions NOT claimed');
  assert.match(buildVideoGraph({ ...base, reframe: 'fit_blur' }).graph, /boxblur/);
  const v = buildVideoGraph({ ...base, inW: 1080, inH: 1920 });
  assert.equal(v.treatments.find((t) => t.dimension === 'reframe_9x16')!.applied, false);
  assert.match(buildVideoGraph({ ...base, assPath: '/tmp/a:b,c.ass' }).graph, /subtitles='\/tmp\/a\\:b\\,c\.ass'/);
});

test('face-tracked crop position is clamped', () => {
  assert.match(buildVideoGraph({ ...base, cropXFrac: 5 }).graph, /iw\*0\.950/);
  assert.match(buildVideoGraph({ ...base, cropXFrac: -1 }).graph, /iw\*0\.050/);
});

test('audio graph: none when no audio; loudnorm target; music only when provided', () => {
  assert.equal(buildAudioGraph({ hasAudio: false, targetLufs: -14, duration: 10 }).graph, null);
  assert.match(buildAudioGraph({ hasAudio: true, targetLufs: -14, duration: 10 }).graph!, /loudnorm=I=-14/);
  assert.match(buildAudioGraph({ hasAudio: true, targetLufs: -14, duration: 10, music: true }).graph!, /sidechaincompress/);
});

test('treatment coverage counts only applied dimensions; unimplemented ones are listed', () => {
  const v = buildVideoGraph(base); const a = buildAudioGraph({ hasAudio: true, targetLufs: -14, duration: 20 });
  const cov = treatmentCoverage([...v.treatments, ...a.treatments]);
  assert.equal(cov.total, DIMENSIONS.length); assert.ok(cov.notApplied.includes('speed_ramp') && cov.notApplied.includes('beat_effects'));
  assert.ok(cov.coverage > 0 && cov.coverage < 1);
});

test('ASS captions: relative timing, clipped to range, strips override braces, title only when given', () => {
  const ass = buildAss([{ start: 10, end: 12, text: 'hello {\\evil} world' }, { start: 30, end: 31, text: 'outside' }], 10, 20, 'My Title', { width: 1080, height: 1920, font: 'Poppins', highlight: '&H0000F0FF&', wordsPerChunk: 3 });
  assert.match(ass, /Dialogue: 0,0:00:00\.00/); assert.ok(!ass.includes('outside')); assert.ok(!ass.includes('evil}')); assert.match(ass, /My Title/);
  assert.ok(!buildAss([], 0, 5, null, { width: 1080, height: 1920, font: 'P', highlight: 'x', wordsPerChunk: 3 }).includes('Dialogue'));
  assert.equal(escFilterPath("a'b"), "a\\'b");
});

test('ebur128 parser', () => {
  assert.deepEqual(parseEbur128('Summary:\n  Integrated loudness:\n    I:         -14.2 LUFS\n  True peak:\n    Peak:       -1.3 dBFS'), { lufs: -14.2, truePeak: -1.3 });
  assert.deepEqual(parseEbur128('nothing'), { lufs: null, truePeak: null });
});

test('fit_blur with fitZoom 1 keeps the full width (no side crop) while 0.8 trims sides', () => {
  const base = { inW: 854, inH: 480, outW: 1080, outH: 1920, reframe: 'fit_blur' as const };
  assert.doesNotMatch(reframeParts({ ...base, fitZoom: 1 }).parts.join(';'), /crop=w='trunc\(iw\*/);
  assert.match(reframeParts({ ...base, fitZoom: 0.8 }).parts.join(';'), /crop=w='trunc\(iw\*0\.800/);
});

test('close-up inserts: planned from strong moments (<=2, >=4 s apart, none under 10 s) and encoded as held zoom windows', async () => {
  const { planCloseups, zoomExpr } = await import('../src/edit/beats.ts');
  assert.deepEqual(planCloseups([2, 3], 8), []); const c = planCloseups([2, 3, 9, 14], 20); assert.ok(c.length >= 1 && c.length <= 2); assert.ok(c.every((x) => x.start >= 0.6 && x.end <= 19.4 && x.end > x.start));
  const e = zoomExpr(300, 30, false, [], [{ start: 2, end: 3.6 }]); assert.match(e, /0\.16\*clip\(min\(/); assert.match(e, /1\.3\)$/);
});
