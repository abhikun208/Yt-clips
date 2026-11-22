import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLayout, safeCrop, type Sample, type Face } from '../src/framing/plan.ts';

const f = (x: number, speaking?: number): Face => ({ x, y: 0.3, w: 0.15, h: 0.25, ...(speaking !== undefined ? { speaking } : {}) });
const seq = (n: number, faces: Face[]): Sample[] => Array.from({ length: n }, (_, i) => ({ t: i * 0.5, faces }));

test('layout: no face -> fit, one -> single, two -> split, three -> trio (max tiles respected)', () => {
  assert.equal(planLayout(seq(8, []))[0]!.layout, 'fit'); assert.equal(planLayout(seq(8, [f(0.5)]))[0]!.layout, 'single');
  assert.equal(planLayout(seq(8, [f(0.2), f(0.7)]))[0]!.layout, 'split');
  assert.equal(planLayout(seq(8, [f(0.1), f(0.4), f(0.7)]), { maxTiles: 3 })[0]!.layout, 'trio'); assert.equal(planLayout(seq(8, [f(0.1), f(0.4), f(0.7)]), { maxTiles: 2 })[0]!.layout, 'split');
});
test('layout: tiles are ordered left-to-right with their centre X; tiny specks ignored', () => {
  const sp = planLayout(seq(6, [f(0.7), f(0.1), { x: 0.5, y: 0.5, w: 0.01, h: 0.01 }]))[0]!; assert.equal(sp.layout, 'split'); assert.ok(sp.focus[0]! < sp.focus[1]!);
});
test('hysteresis: a 1 s blip (second face flashes) does not flip the layout; a real change does', () => {
  const s: Sample[] = [...seq(8, [f(0.5)]), { t: 4, faces: [f(0.2), f(0.7)] }, { t: 4.5, faces: [f(0.2), f(0.7)] }, ...seq(8, [f(0.5)]).map((x) => ({ ...x, t: x.t + 5 })) ];
  const spans = planLayout(s, { minSpanSec: 2 }); assert.deepEqual(spans.map((x) => x.layout), ['single'], 'blip absorbed');
  const real: Sample[] = [...seq(10, [f(0.5)]), ...seq(10, [f(0.2), f(0.7)]).map((x) => ({ ...x, t: x.t + 5 }))]; assert.deepEqual(planLayout(real).map((x) => x.layout), ['single', 'split']);
});
test('speakerOnly follows the speaking face (podcast cut-to-speaker)', () => {
  const sp = planLayout(seq(8, [f(0.2, 0.1), f(0.75, 0.9)]), { speakerOnly: true })[0]!; assert.equal(sp.layout, 'single'); assert.ok(sp.focus[0]! > 0.7);
});
test('safeCrop: keeps HUD / minimap / kill feed / facecam whole when possible, otherwise says so', () => {
  const hud = { x: 0.30, y: 0.85, w: 0.12, h: 0.1 }; const c = safeCrop([hud], 0.2); assert.equal(c.ok, true); assert.ok(c.x <= hud.x + 1e-6 && c.x + c.w >= hud.x + hud.w - 1e-6, 'window contains the HUD although prefer was far left');
  const wide = safeCrop([{ x: 0.2, y: 0, w: 0.5, h: 0.2 }], 0.5); assert.equal(wide.ok, false); assert.match(wide.note, /blur-fit/);
  const none = safeCrop([], 0.5); assert.equal(none.ok, true); assert.ok(Math.abs(none.x + none.w / 2 - 0.5) < 0.01);
});
