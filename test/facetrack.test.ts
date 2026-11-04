import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.ts';

const hasCv2 = spawnSync('python3', ['-I', '-c', 'import cv2']).status === 0;
test('face tools: with a detector present the crop track follows the face (stub detector walks left to right); without any detector they report no_detector instead of crashing', { skip: !hasCv2 }, () => {
  const d = tmpDir(); const tools = join(d, 'tools'); mkdirSync(tools);
  for (const f of ['face_center.py', 'face_track.py']) copyFileSync(join(process.cwd(), 'tools', f), join(tools, f));
  const vid = join(d, 'v.mp4'); assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6', '-pix_fmt', 'yuv420p', vid]).status, 0);
  copyFileSync(join(process.cwd(), 'tools', 'facedet.py'), join(tools, 'facedet.py')); // real module: on OpenCV 5 without model => no_detector
  const real = spawnSync('python3', ['-I', join(tools, 'face_track.py'), vid, '5'], { encoding: 'utf8' }); const j0 = JSON.parse(real.stdout.trim().split('\n').pop()!); assert.ok(j0.error === 'no_detector' || j0.faces >= 0, real.stdout + real.stderr);
  writeFileSync(join(tools, 'facedet.py'), 'n = [0]\ndef load(cv2):\n    def d(fr):\n        n[0] += 1\n        return [(20 + n[0] * 8, 60, 60, 60)]\n    return d\n');
  const r = spawnSync('python3', ['-I', join(tools, 'face_track.py'), vid, '5'], { encoding: 'utf8' }); const j = JSON.parse(r.stdout.trim().split('\n').pop()!); assert.ok(j.faces > 0, r.stdout + r.stderr); assert.ok(j.track.length > 3);
  assert.ok(j.track[j.track.length - 1][1] > j.track[0][1] + 0.1, 'track moves with the face: ' + JSON.stringify(j.track.slice(0, 3)));
  const c = spawnSync('python3', ['-I', join(tools, 'face_center.py'), vid, '6'], { encoding: 'utf8' }); const jc = JSON.parse(c.stdout.trim().split('\n').pop()!); assert.ok(jc.cx > 0 && jc.cx < 1, c.stdout + c.stderr);
});

test('speaker-follow keyframes: denser (up to 72) yet the expression stays under ffmpeg\'s limit and really runs', async () => {
  const { trackExpr } = await import('../src/edit/filters.ts'); const { spawnSync } = await import('node:child_process');
  const tr: [number, number][] = Array.from({ length: 150 }, (_, i) => [i * 0.4, 0.5 + 0.3 * Math.sin(i / 5)]); const e = trackExpr(tr); assert.ok(e.length < 4000, String(e.length));
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=20:r=10', '-vf', `crop=w=202:h=360:x='max(0,min(iw-ow,(${e})*iw-ow/2))':y=0`, '-t', '20', '-f', 'null', '-']); assert.equal(r.status, 0, String(r.stderr));
});

test('motion smoothness (measured): camera moves EVERY frame between keyframes, no staircase', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', ['tools/motion_check.ts'], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  const m = /ZERO movement \(marker visible\): (\d+)\/(\d+); max step (\d+)px/.exec(r.stdout); assert.ok(m, r.stdout);
  assert.equal(Number(m[1]), 0); assert.ok(Number(m[2]) > 60); assert.ok(Number(m[3]) < 60, 'no jump bigger than ~40px/frame');
  const k = /velocity change: (\d+)px\/frame\^2; hard kinks: (\d+)/.exec(r.stdout); assert.ok(k, r.stdout); assert.equal(Number(k[2]), 0, 'direction changes ease through zero (no instant reversal)'); assert.ok(Number(k[1]) < 20, 'smooth acceleration: ' + k[1]);
});

test('look-ahead camera: crop reaches a new speaker position BEFORE the speaker gets there (anticipation, not lag)', async () => {
  const { reframeParts, CROP_LEAD_SEC } = await import('../src/edit/filters.ts');
  const tr: [number, number][] = [[0, 0.3], [1, 0.3], [2, 0.7], [3, 0.7]];
  const g = reframeParts({ inW: 1920, inH: 1080, outW: 1080, outH: 1920, reframe: 'crop', cropTrack: tr } as any).parts.join(' ');
  assert.ok(CROP_LEAD_SEC > 0 && CROP_LEAD_SEC <= 0.3);
  assert.ok(g.includes(`lt(t,${+(1 - CROP_LEAD_SEC).toPrecision(5)})`), 'first keyframe segment ends earlier by the lead: ' + g.slice(0, 200));
});
