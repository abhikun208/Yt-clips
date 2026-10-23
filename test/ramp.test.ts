import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planRamp, rampedDuration, mapTime, remapCues, rampFilter } from '../src/edit/ramp.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir, makeFixture } from './helpers.ts';

test('ramp math: plan bounds, duration, monotonic time map, caption re-timing', () => {
  assert.equal(planRamp(undefined, 20), null); assert.equal(planRamp(5, 6), null, 'short clip: none');
  const r = planRamp(10, 20)!; assert.ok(r.a >= 0.5 && r.b <= 19.5 && r.b > r.a);
  assert.ok(Math.abs(rampedDuration(20, r) - (20 + (r.b - r.a) * (1 / r.rate - 1))) < 1e-9);
  assert.equal(mapTime(r.a - 1, r), r.a - 1); assert.ok(Math.abs(mapTime(r.b, r) - (r.a + (r.b - r.a) / r.rate)) < 1e-9); assert.ok(Math.abs(mapTime(20, r) - rampedDuration(20, r)) < 1e-9);
  let prev = -1; for (let t = 0; t <= 20; t += 0.25) { const x = mapTime(t, r); assert.ok(x > prev); prev = x; }
  const cues = remapCues([{ start: 100 + 9, end: 100 + 12, text: 'a b', words: [{ start: 109, end: 110, text: 'a' }, { start: 110, end: 112, text: 'b' }] }], 100, r);
  assert.ok(cues[0]!.end - cues[0]!.start > 3, 'cue inside the slow window gets longer'); assert.ok(cues[0]!.words![1]!.start >= cues[0]!.words![0]!.end - 1e-9);
});

test('real ffmpeg: ramped output duration matches prediction, audio and video stay in sync', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4'); await makeFixture(src, 10); const out = join(d, 'o.mp4');
  const ramp = { a: 6, b: 8, rate: 0.5 };
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex', rampFilter(ramp, true), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out], { timeoutMs: 120000 });
  assert.equal(r.code, 0, r.stderr);
  const pr = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', out]);
  const dur = Object.fromEntries(pr.stdout.trim().split('\n').map((l) => { const [t, x] = l.split(','); return [t!, Number(x)]; }));
  const src_dur = 18; const want = src_dur + (ramp.b - ramp.a) * (1 / ramp.rate - 1);
  assert.ok(Math.abs(dur.video! - want) < 0.3, `video ${dur.video} vs ${want}`); assert.ok(Math.abs(dur.audio! - want) < 0.3, `audio ${dur.audio} vs ${want}`);
});
