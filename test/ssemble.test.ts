import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';
import { buildVideoGraph } from '../src/edit/filters.ts';
import { buildStyledAss } from '../src/edit/captions.ts';
import { pickFiller } from '../src/edit/render.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir, makeFixture } from './helpers.ts';
import { probe } from '../src/media/probe.ts';

test('split_gameplay: real ffmpeg, 2 inputs → 9:16 output; filler pick deterministic', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4'); await makeFixture(src, 10);
  mkdirSync(join(d, 'gameplay')); copyFileSync(src, join(d, 'gameplay', 'a.mp4'));
  const f = pickFiller(d, 7); assert.ok(f && f.endsWith('a.mp4')); assert.equal(pickFiller(d, 7), f); assert.equal(pickFiller(join(d, 'none'), 1), null);
  const g = buildVideoGraph({ inW: 320, inH: 180, outW: 270, outH: 480, fps: 15, duration: 5, mood: 'happy', reframe: 'split_gameplay', fillIdx: 1, zoom: false, glow: false, fade: false });
  assert.ok(g.treatments.some((t) => /split screen/.test(t.detail)));
  const out = join(d, 'o.mp4');
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-stream_loop', '-1', '-i', f!, '-filter_complex', g.graph, '-map', '[vout]', '-an', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', out], { timeoutMs: 120_000 });
  assert.equal(r.code, 0, r.stderr.slice(0, 500)); const p = await probe(out); assert.equal(p.width, 270); assert.equal(p.height, 480);
});
test('CTA overlay appears in the last seconds of the ASS; not for tiny clips', () => {
  const cues = [{ start: 0, end: 3, text: 'bhai yeh dekho kya hua' }];
  const a = buildStyledAss(cues, 0, 20, null, { width: 1080, height: 1920, cta: 'AGLA PART DEKHO' });
  assert.match(a.ass, /Dialogue: 1,0:00:17\.00,0:00:20\.00,Title,.*AGLA PART DEKHO/);
  assert.ok(!/AGLA PART/.test(buildStyledAss(cues, 0, 4, null, { width: 1080, height: 1920, cta: 'AGLA PART DEKHO' }).ass));
});
import { LENGTHS, isLengthBucket } from '../src/analysis/analyzer.ts';
test('length buckets valid and ordered', () => {
  assert.ok(isLengthBucket('30-60') && !isLengthBucket('5-10'));
  for (const b of Object.values(LENGTHS)) assert.ok(b.minSec < b.targetSec && b.targetSec < b.maxSec);
});
import { trackExpr } from '../src/edit/filters.ts';
test('speaker-follow crop: keyframe expression renders in real ffmpeg; face_track.py degrades gracefully', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4'); await makeFixture(src, 10);
  const g = buildVideoGraph({ inW: 320, inH: 180, outW: 270, outH: 480, fps: 15, duration: 5, mood: 'happy', reframe: 'crop', cropTrack: [[0, 0.3], [2, 0.3], [3, 0.7], [5, 0.7]], zoom: false, glow: false, fade: false });
  assert.ok(g.treatments.some((t) => /speaker-follow/.test(t.detail)));
  const out = join(d, 'o.mp4'); const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex', g.graph, '-map', '[vout]', '-an', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', out], { timeoutMs: 120_000 });
  assert.equal(r.code, 0, r.stderr.slice(0, 400));
  assert.match(trackExpr([[0, 0.3], [1, 0.5], [2, 0.5]]), /^if\(lt\(t,0\.00\)/);
  const t = await run('python3', ['-I', join(process.cwd(), 'tools', 'face_track.py'), src, '5'], { timeoutMs: 120_000 });
  const j = JSON.parse(t.stdout) as { track: unknown[]; faces: number }; assert.ok(Array.isArray(j.track)); assert.equal(j.faces, 0);
});
