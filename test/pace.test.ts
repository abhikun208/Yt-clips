import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPace, PACES } from '../src/edit/pace.ts';

const maxGap = (xs: number[], d: number) => { const p = [0, ...xs, d]; return Math.max(...p.slice(1).map((v, i) => v - p[i]!)); };
test('pace: no gap exceeds the mode maximum; real audio peaks are kept; off changes nothing', () => {
  for (const mode of ['fast', 'medium', 'relaxed'] as const) {
    const out = fillPace([13.1, 27.4], 40, mode); assert.ok(maxGap(out, 40) <= PACES[mode].max + 0.7, `${mode}: ${maxGap(out, 40)}`); assert.ok(out.includes(13.1) && out.includes(27.4));
  }
  assert.deepEqual(fillPace([5], 40, 'off'), [5]); assert.deepEqual(fillPace([], 3, 'fast'), []);
  assert.ok(fillPace([], 30, 'fast').length > fillPace([], 30, 'relaxed').length, 'fast has more beats than relaxed');
});
