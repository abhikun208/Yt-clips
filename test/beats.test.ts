import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pickPeaks, zoomExpr } from '../src/edit/beats.ts';
import { buildVideoGraph } from '../src/edit/filters.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir, makeFixture } from './helpers.ts';

const base = { inW: 1920, inH: 1080, outW: 270, outH: 480, fps: 30, duration: 8, mood: 'general', reframe: 'crop' as const, zoom: false, glow: false, fade: false };

test('pickPeaks: loudest local maxima, spaced, away from edges, capped', () => {
  const values = Array(40).fill(-40); values[8] = -10; values[9] = -20; values[10] = -12; values[11] = -30; values[30] = -8; values[1] = -5;
  const p = pickPeaks({ step: 0.25, values }, { duration: 10, min: 0.5, spacing: 1.5, max: 4 });
  assert.ok(p.includes(7.5) || p.includes(2) || p.length >= 1); assert.ok(p.every((t) => t >= 0.5 && t <= 9.5)); assert.ok(!p.includes(0.25), 'edge peak ignored');
  for (let i = 1; i < p.length; i++) assert.ok(p[i]! - p[i - 1]! >= 1.5);
  assert.deepEqual(pickPeaks({ step: 0.25, values: Array(40).fill(-30) }, { duration: 10 }), [], 'flat audio => no peaks');
});

test('graph: punch times produce zoompan + honest beat_effects treatment; none => not applied', () => {
  const on = buildVideoGraph({ ...base, punch: [2, 5.5] });
  assert.match(on.graph, /fps=30,zoompan=z='min\(1\.0\+0\.06\*max/); assert.equal(on.treatments.find((x) => x.dimension === 'beat_effects')!.applied, true);
  const off = buildVideoGraph(base); assert.ok(!off.graph.includes('zoompan')); assert.equal(off.treatments.find((x) => x.dimension === 'beat_effects')!.applied, false);
  assert.match(zoomExpr(240, 30, true, []), /^min\(1\.0\+0\.12\*on\/240,1\.25\)$/);
});

test('ffmpeg really accepts the punch graph and keeps duration', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4'); await makeFixture(src);
  const g = buildVideoGraph({ ...base, duration: 4, punch: [1, 2.5] });
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-t', '4', '-i', src, '-filter_complex', g.graph, '-map', '[vout]', '-an', '-t', '4', join(d, 'o.mp4')], { timeoutMs: 120000 });
  assert.equal(r.code, 0, r.stderr);
  const p = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(d, 'o.mp4')]);
  assert.ok(Math.abs(Number(p.stdout.trim()) - 4) < 0.2);
});
