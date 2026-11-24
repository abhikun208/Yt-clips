import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { discoverEvents, clusterSeeds, detectMoments, dedupeMoments, DEFAULT_MOMENT_CFG, type MomentInput } from '../src/analysis/moment-detector.ts';
import { visualActivity, parseMotion } from '../src/analysis/signals.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';

const base = (over: Partial<MomentInput> = {}): MomentInput => ({ duration: 600, lo: 0, hi: 600, energy: new Array(1200).fill(0.2), energyStep: 0.5, silence: [], scenes: [], cues: [], ...over });
const spike = (e: number[], at: number, v = 0.95) => { for (let i = Math.floor(at / 0.5); i < Math.floor(at / 0.5) + 4; i++) e[i] = v; };

test('audio-only spike is discovered but can never rank above CONDITIONAL (loudness is not enough)', () => {
  const e = new Array(1200).fill(0.2); spike(e, 300);
  const r = detectMoments(base({ energy: e }));
  const m = r.moments.find((x) => Math.abs(x.peakAt - 300) < 4); assert.ok(m, JSON.stringify(r.stats));
  assert.ok(['CONDITIONAL', 'REJECTED'].includes(m!.tier), m!.tier); assert.ok(m!.missing.includes('transcript'));
});

test('Hindi/Hinglish transcript reaction creates events and a setup->payoff pattern with context kept', () => {
  const cues = [
    { start: 290, end: 294, text: 'ye galti ho gayi yaar' }, { start: 294.2, end: 297, text: 'अरे नहीं नहीं मार दिया!' }, { start: 297.2, end: 300, text: 'hahaha kya baat hai' },
  ];
  const e = new Array(1200).fill(0.25); spike(e, 295);
  const r = detectMoments(base({ energy: e, cues, gaming: true }));
  const m = r.moments.find((x) => x.start <= 295 && x.end >= 295)!; assert.ok(m);
  assert.ok(m.kinds.includes('reaction') || m.kinds.includes('laughter')); assert.notEqual(m.pattern, 'none');
  assert.ok(m.start <= 290.1, 'setup sentence included'); assert.ok(m.end >= 299.9, 'reaction finished');
  assert.ok(m.duration >= DEFAULT_MOMENT_CFG.minSec && m.duration <= DEFAULT_MOMENT_CFG.maxSec);
});

test('boundaries never cut mid-word when word timestamps exist', () => {
  const words = [{ start: 288.0, end: 289.0, text: 'ye' }, { start: 289.0, end: 291.0, text: 'dekhna' }, { start: 291.0, end: 293.0, text: 'zabardast' }, { start: 293.0, end: 298.0, text: 'wow!' }];
  const cues = [{ start: 288, end: 298, text: 'ye dekhna zabardast wow!', words }];
  const r = detectMoments(base({ cues }));
  for (const m of r.moments) for (const w of words) { assert.ok(!(m.start > w.start && m.start < w.end), `start inside word ${w.text}`); assert.ok(!(m.end > w.start && m.end < w.end), `end inside word ${w.text}`); }
});

test('missing evidence is listed, excluded, and lowers confidence', () => {
  const e = new Array(1200).fill(0.2); spike(e, 100);
  const a = detectMoments(base({ energy: e })).moments[0]!; const b = detectMoments(base({ energy: e, cues: [{ start: 95, end: 101, text: 'wow kya baat hai!' }], motion: { step: 0.25, values: new Array(2400).fill(1) } })).moments[0]!;
  assert.ok(a.missing.length > b.missing.length); assert.ok(a.confidence < b.confidence); assert.equal(a.breakdown.hook, null);
});

test('dedupe: same event twice merges, distinct events stay separate (IoU>0.6 is a trigger, not auto-merge)', () => {
  const mk = (s: number, e: number, peak: number, text: string) => ({ start: s, end: e, duration: e - s, tier: 'STRONG' as const, score: 0.6, confidence: 0.8, pattern: 'none' as const, kinds: [], peakAt: peak, breakdown: { uniqueness: 1 }, missing: [], reasons: [], explanation: '', hook: '', transcript: text, contextComplete: true, boundary: 'words' as const, category: 'x' });
  const d = dedupeMoments([mk(100, 130, 115, 'same thing happening'), mk(102, 132, 117, 'same thing happening')]); assert.equal(d.kept.length, 1);
  const d2 = dedupeMoments([mk(100, 130, 115, 'alpha beta gamma'), mk(200, 230, 215, 'totally different words here')]); assert.equal(d2.kept.length, 2);
});

test('coverage events sample long quiet stretches; events are bounded', () => {
  const ev = discoverEvents(base({ duration: 1800, hi: 1800, energy: new Array(3600).fill(0.2) })); assert.ok(ev.some((x) => x.kind === 'coverage') || ev.length === 0);
  const e = Array.from({ length: 1200 }, (_, i) => (i % 6 === 0 ? 0.95 : 0.2)); assert.ok(discoverEvents(base({ energy: e })).length <= DEFAULT_MOMENT_CFG.maxEvents);
  assert.ok(clusterSeeds([{ t: 1, kind: 'audio_peak', strength: 1 }, { t: 3, kind: 'reaction', strength: 0.5 }], 8).length === 1);
});

test('real ffmpeg: visualActivity finds cuts and parseMotion yields a series', { timeout: 60_000 }, async () => {
  const f = join(tmpDir(), 'm.mp4');
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=10:d=4', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=4', '-filter_complex', '[0][1]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', f], { timeoutMs: 30000 });
  assert.equal(r.code, 0); const v = await visualActivity(f); assert.ok(v.scenes.length >= 1); assert.ok(v.motion.values.length > 20);
  assert.equal(parseMotion('', 0.25).values.length, 0);
});
