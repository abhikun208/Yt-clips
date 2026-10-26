import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoGraph } from '../src/edit/filters.ts';
import { VFX_DEFAULTS } from '../src/edit/vfx.ts';
import { parseIdet } from '../src/edit/sourcecheck.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';
import { join } from 'node:path';

test('regression: glow/particles/light-leak screen blends no longer shift neutral footage toward magenta (chroma planes stay ~128)', async () => {
  const out = join(tmpDir(), 'o.mp4');
  for (const mood of ['aggressive', 'funny', 'neutral'] as const) {
    const g = buildVideoGraph({ inW: 1280, inH: 720, outW: 540, outH: 960, fps: 30, duration: 2, mood: mood as never, reframe: 'crop', zoom: false, glow: true, fade: false, vfx: { ...VFX_DEFAULTS, grain: false, flashAt: [] } }).graph;
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1280x720:r=30:d=2', '-filter_complex', g, '-map', '[vout]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { timeoutMs: 120_000 }); assert.equal(r.code, 0, r.stderr.slice(0, 300));
    const s = await run('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { timeoutMs: 60_000 });
    const u = [...s.stdout.matchAll(/UAVG=([\d.]+)/g)].map((x) => Number(x[1])), v = [...s.stdout.matchAll(/VAVG=([\d.]+)/g)].map((x) => Number(x[1]));
    const mu = u.reduce((a, b) => a + b, 0) / u.length, mv = v.reduce((a, b) => a + b, 0) / v.length;
    assert.ok(Math.abs(mu - 128) < 16 && Math.abs(mv - 128) < 16, `${mood}: U=${mu.toFixed(1)} V=${mv.toFixed(1)} (neutral grey must stay near 128)`);
  }
});
test('idet parsing: combed TV footage detected, progressive not', () => {
  assert.equal(parseIdet('Multi frame detection: TFF:   120 BFF:     0 Progressive:    10 Undetermined:     2'), true);
  assert.equal(parseIdet('Multi frame detection: TFF:     0 BFF:     0 Progressive:   150 Undetermined:     0'), false);
  assert.equal(parseIdet('nothing'), false);
});
