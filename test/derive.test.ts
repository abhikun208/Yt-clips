import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareForPlatform } from '../src/publish/mediaCheck.ts';
import { probe } from '../src/media/probe.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';

async function mk(file: string, size: string, secs: number): Promise<void> {
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=25:d=${secs}`, '-f', 'lavfi', '-i', `sine=f=300:d=${secs}`, '-c:v', 'libx264', '-b:v', '3M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]); assert.equal(r.code, 0, r.stderr);
}

test('platform re-encode: over-long, over-size and horizontal masters get validated derived copies; the master is untouched', async () => {
  const dir = tmpDir(); const f = join(dir, 'clip.mp4'); await mk(f, '270x480', 12); const masterSize = statSync(f).size;
  const lim = { reels: { maxSeconds: 8, maxMB: 1, vertical: true } };
  const r = await prepareForPlatform(f, 'reels', lim); assert.equal(r.ok, true, r.problems.join()); assert.equal(r.derived, true); assert.match(r.path, /clip\.reels\.mp4$/);
  const i = await probe(r.path); assert.ok(i.duration <= 8, `duration ${i.duration}`); assert.ok(statSync(r.path).size <= 1048576, 'fits the size limit'); assert.equal(i.videoCodec, 'h264');
  assert.ok(r.notes.some((n) => /trimmed/.test(n)) && r.notes.some((n) => /re-encoded/.test(n)));
  assert.equal(statSync(f).size, masterSize, 'master untouched'); assert.ok(existsSync(f));
  const ok = await prepareForPlatform(f, 'reels', { reels: { maxSeconds: 60, maxMB: 100, vertical: true } }); assert.deepEqual([ok.ok, ok.derived, ok.path], [true, false, f], 'already valid: no re-encode');
  const h = join(dir, 'wide.mp4'); await mk(h, '480x270', 4); const w = await prepareForPlatform(h, 'reels', lim); assert.equal(w.ok, true, w.problems.join()); assert.equal(w.derived, true); assert.match(w.path, /wide\.reels\.mp4$/); assert.ok(w.notes.some((n) => /fit_blur/.test(n))); const wi = await probe(w.path); assert.ok(wi.height > wi.width, 'derived output is vertical');
  const none = await prepareForPlatform(join(dir, 'missing.mp4'), 'reels', lim); assert.equal(none.ok, false);
});
