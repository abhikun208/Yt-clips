import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseSilences, snapCues, speechRegions } from '../src/analysis/align.ts';
import { tmpDir } from './helpers.ts';

test('parseSilences turns ffmpeg silencedetect output into speech regions', () => {
  const err = 'silence_start: 0\nsilence_end: 1.0 | silence_duration: 1\nsilence_start: 2.2\nsilence_end: 3.4\nsilence_start: 5.0\n';
  assert.deepEqual(parseSilences(err, 9), [{ start: 1, end: 2.2 }, { start: 3.4, end: 5 }]);
});
test('snapCues: approximate cue edges move to the real speech onset/offset; words spread over speech time only; text untouched', () => {
  const sp = [{ start: 1, end: 2.2 }, { start: 3.4, end: 5 }];
  const out = snapCues([{ start: 0.4, end: 2.9, text: 'yeh pehli baat hai' }, { start: 3.0, end: 5.9, text: 'doosri baat suno' }], sp);
  assert.deepEqual([out[0]!.start, out[0]!.end, out[1]!.start, out[1]!.end], [1, 2.2, 3.4, 5]);
  assert.equal(out[0]!.text, 'yeh pehli baat hai'); assert.equal(out[0]!.words!.length, 4); assert.ok(out[0]!.words!.every((w) => w.start >= 1 && w.end <= 2.2 + 1e-9));
  assert.deepEqual(snapCues([{ start: 0, end: 1, text: 'x' }], []), [{ start: 0, end: 1, text: 'x' }]); // no speech info: unchanged
});
test('speechRegions finds real tone bursts in a generated video (ffmpeg silencedetect)', async () => {
  const d = tmpDir(); const f = join(d, 's.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=7', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,2.2)+between(t,3.4,5), 0.3*sin(2*PI*220*t), 0)':s=16000:d=7", '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  assert.equal(r.status, 0, String(r.stderr)); const sp = await speechRegions(f, 7);
  assert.equal(sp.length, 2); assert.ok(Math.abs(sp[0]!.start - 1) < 0.25 && Math.abs(sp[0]!.end - 2.2) < 0.25 && Math.abs(sp[1]!.start - 3.4) < 0.25 && Math.abs(sp[1]!.end - 5) < 0.25, JSON.stringify(sp));
  writeFileSync(join(d, 'x'), '');
});

test('snapping is skipped for noisy/music audio (no clear pauses) and cue text/timing stay unchanged', async () => {
  const { refineApproxCues } = await import('../src/analysis/align.ts'); const d = tmpDir(); const f = join(d, 'n.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=6', '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:a=0.3:r=16000', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]); assert.equal(r.status, 0);
  const cues = [{ start: 0.4, end: 2.9, text: 'yeh baat hai' }]; const out = await refineApproxCues(process.cwd(), d, f, cues, 'hi', 6);
  assert.deepEqual(out.cues, cues); assert.match(out.how, /unchanged/);
});

test('soft-spoken audio: adaptive silence threshold still finds the speech (a fixed -32 dB would call it all silence)', async () => {
  const { speechRegions } = await import('../src/analysis/align.ts'); const d = tmpDir(); const f = join(d, 'soft.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=7', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,2.2)+between(t,3.4,5), 0.012*sin(2*PI*220*t), 0)':s=16000:d=7", '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]); assert.equal(r.status, 0);
  const fixed = await speechRegions(f, 7, -32); assert.equal(fixed.length, 0); // the old fixed threshold sees nothing
  const sp = await speechRegions(f, 7); assert.equal(sp.length, 2, JSON.stringify(sp)); assert.ok(Math.abs(sp[0]!.start - 1) < 0.3 && Math.abs(sp[1]!.end - 5) < 0.3);
});

test('music bed: loud bass music under the voice no longer hides the pauses (voice-band filter before silence detection)', async () => {
  const { speechRegions } = await import('../src/analysis/align.ts'); const d = tmpDir(); const f = join(d, 'bed.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=7', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*70*t)+if(between(t,1,2.2)+between(t,3.4,5), 0.3*sin(2*PI*600*t), 0)':s=16000:d=7", '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]); assert.equal(r.status, 0);
  const sp = await speechRegions(f, 7); assert.equal(sp.length, 2, JSON.stringify(sp)); assert.ok(Math.abs(sp[0]!.start - 1) < 0.3 && Math.abs(sp[1]!.end - 5) < 0.3);
});
