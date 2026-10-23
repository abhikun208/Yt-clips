import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildVideoGraph, treatmentCoverage, DIMENSIONS } from '../src/edit/filters.ts';
import { curveFor, findLut } from '../src/edit/vfx.ts';
import { measureVisualChange } from '../src/edit/change.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir, makeFixture } from './helpers.ts';

const base = { inW: 320, inH: 180, outW: 270, outH: 480, fps: 15, duration: 10, mood: 'happy', reframe: 'crop' as const, zoom: false, glow: false, fade: false };
const ALL = { lut: true, grain: true, particles: true, lightLeak: true, flash: true, flashAt: [3, 6] };
const NONE = { lut: false, grain: false, particles: false, lightLeak: false, flash: false, flashAt: [] };

async function render(src: string, out: string, vfx: typeof ALL | typeof NONE, extra: Record<string, unknown> = {}) {
  const g = buildVideoGraph({ ...base, vfx, ...extra });
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex', g.graph, '-map', '[vout]', '-an', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', out], { timeoutMs: 180_000 });
  assert.equal(r.code, 0, r.stderr.slice(0, 600));
  return g;
}

test('every vfx treatment is recorded; coverage counts the new dimensions honestly', () => {
  const on = buildVideoGraph({ ...base, vfx: ALL }); const off = buildVideoGraph({ ...base, vfx: NONE }); const none = buildVideoGraph(base);
  for (const d of ['cinematic_lut', 'film_grain', 'particles', 'light_leak', 'flash_transition']) {
    assert.ok(on.treatments.find((x) => x.dimension === d)?.applied, d); assert.equal(off.treatments.find((x) => x.dimension === d)?.applied, false, d); assert.equal(none.treatments.find((x) => x.dimension === d)?.applied, false, d);
  }
  const c = treatmentCoverage(on.treatments); assert.equal(c.total, DIMENSIONS.length); assert.ok(DIMENSIONS.length >= 21);
  assert.notEqual(curveFor('aggressive').f, curveFor('happy').f);
});

test('real ffmpeg: full vfx graph renders; measured visual change is real (more effects => larger change, none => ~0)', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4'); await makeFixture(src, 10);
  const g = { inW: 320, inH: 180, outW: 270, outH: 480, reframe: 'crop' as const };
  const a = join(d, 'off.mp4'); const b = join(d, 'on.mp4'); const p = join(d, 'particles.mp4');
  await render(src, a, NONE); await render(src, b, ALL);
  await render(src, p, { ...NONE, particles: true });
  const off = (await measureVisualChange(src, a, g))!; const on = (await measureVisualChange(src, b, g))!; const part = (await measureVisualChange(src, p, g))!;
  assert.ok(off && on && part, 'ssim measured');
  assert.ok(on.change > off.change + 0.03, `vfx visibly changes frames: ${on.change} vs ${off.change}`);
  assert.ok(part.change > off.change + 0.002, `particles alone change pixels: ${part.change}`);
});

test('real ffmpeg: owner .cube LUT is applied via lut3d (invert LUT flips a frame)', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4'); await makeFixture(src, 6); const assets = join(d, 'assets'); mkdirSync(join(assets, 'luts'), { recursive: true });
  const n = 2; const rows: string[] = [`LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let gg = 0; gg < n; gg++) for (let r = 0; r < n; r++) rows.push(`${1 - r} ${1 - gg} ${1 - b}`);
  writeFileSync(join(assets, 'luts', 'invert.cube'), rows.join('\n')); const lut = findLut(assets)!; assert.ok(lut.endsWith('invert.cube'));
  const out = join(d, 'lut.mp4'); const g = await render(src, out, { ...NONE, lut: true }, { vfx: { ...NONE, lut: true, lutFile: lut } });
  assert.match(g.treatments.find((x) => x.dimension === 'cinematic_lut')!.detail, /owner LUT invert\.cube/);
  const m = (await measureVisualChange(src, out, { inW: 320, inH: 180, outW: 270, outH: 480, reframe: 'crop' }))!; assert.ok(m.change > 0.3, `inverted colours differ a lot: ${m.change}`);
});
