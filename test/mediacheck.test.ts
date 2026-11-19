import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { run } from '../src/util/proc.ts';
import { checkMedia } from '../src/publish/mediaCheck.ts';
import { tmpDir } from './helpers.ts';

const mk = async (name: string, size: string, dur: number) => { const f = join(tmpDir(), name); const r = await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f], { timeoutMs: 60000 }); assert.equal(r.code, 0); return f; };
test('FFprobe pre-upload check: vertical short passes; horizontal, too-long and missing files are refused per platform', async () => {
  const ok = await mk('v.mp4', '360x640', 3); assert.deepEqual((await checkMedia(ok, 'youtube_shorts')).problems, []);
  const wide = await mk('w.mp4', '640x360', 3); assert.match((await checkMedia(wide, 'facebook_reels')).problems.join(), /horizontal/);
  assert.match((await checkMedia(ok, 'facebook_reels', { facebook_reels: { maxSeconds: 2, maxMB: 10, vertical: true } })).problems.join(), /duration/);
  assert.match((await checkMedia('/nonexistent.mp4', 'youtube_shorts')).problems.join(), /nahi mili/);
  assert.equal((await checkMedia(wide, 'unknown_platform')).ok, true);
});
