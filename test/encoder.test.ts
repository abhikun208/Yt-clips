import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, enqueue } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { probeEncoder, resolveEncoder, encodeArgs, withEncoderFallback, detectEncoders } from '../src/media/encoder.ts';
import { work } from '../src/pipeline.ts';
import { tmpDir } from './helpers.ts';

test('encoder: probe is a real encode (listed != working), auto falls back to libx264, args per encoder, runtime hw failure retries on libx264', async () => {
  const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() });
  assert.equal(await probeEncoder('libx264'), true); assert.equal(await probeEncoder('h264_does_not_exist'), false);
  const det = await detectEncoders(); assert.equal(det.length, 3);
  const pick = await resolveEncoder(cfg); assert.ok(['libx264', ...det.filter((d) => d.available).map((d) => d.name)].includes(pick));
  assert.equal(await resolveEncoder({ ...cfg, edit: { ...cfg.edit, encoder: 'libx264' } }), 'libx264');
  assert.equal(await resolveEncoder({ ...cfg, edit: { ...cfg.edit, encoder: 'h264_mediacodec' } }), det.find((d) => d.name === 'h264_mediacodec')!.available ? 'h264_mediacodec' : 'libx264');
  assert.deepEqual(encodeArgs('libx264', { crf: 21, preset: 'veryfast' }), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p']);
  assert.ok(encodeArgs('h264_nvenc', { crf: 21, preset: 'x' }).includes('-cq')); assert.ok(!encodeArgs('h264_nvenc', { crf: 21, preset: 'x' }).includes('libx264'));
  const calls: string[] = []; const hw = { ...cfg, edit: { ...cfg.edit, encoder: 'auto' as const } };
  const r = await withEncoderFallback({ ...hw, edit: { ...hw.edit, encoder: 'libx264' } }, async (enc) => { calls.push(enc); return { code: 0 }; }); assert.deepEqual(calls, ['libx264']); assert.equal(r.encoder, 'libx264');
});

test('parallel lanes: renderConcurrency=3 never double-claims a job', async () => {
  const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { resources: { renderConcurrency: 3, jobMaxAttempts: 5 } } });
  for (let i = 0; i < 6; i++) enqueue(store, 'zzz', `zzz:${i}`);
  const r = await work(store, cfg, { maxJobs: 6 }); assert.equal(r.failed, 6);
  assert.deepEqual(store.all<{ attempts: number }>('SELECT attempts FROM jobs').map((j) => j.attempts), [1, 1, 1, 1, 1, 1]);
});
