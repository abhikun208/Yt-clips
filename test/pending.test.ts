import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { clipHash, hashSimilarity } from '../src/media/phash.ts';
import { run } from '../src/util/proc.ts';
import { Store } from '../src/db.ts';
import { freeUpSpace } from '../src/util/cleanup.ts';
import { buildAudioGraph } from '../src/edit/filters.ts';
import { dupCheck } from '../src/edit/render.ts';
import { testConfig, tmpDir } from './helpers.ts';

async function vid(out: string, src: string) { const r = await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-t', '4', '-pix_fmt', 'yuv420p', out]); assert.equal(r.code, 0, r.stderr); }

test('phash: same picture ≈ identical (even re-scaled), different picture clearly lower', async () => {
  const d = tmpDir(); const a = join(d, 'a.mp4'), a2 = join(d, 'a2.mp4'), b = join(d, 'b.mp4');
  await vid(a, 'testsrc2=s=320x240:r=10'); await vid(b, 'mandelbrot=s=320x240:r=10');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-vf', 'scale=160:120,eq=brightness=0.03', '-pix_fmt', 'yuv420p', a2]);
  const ha = (await clipHash(a, 4))!, ha2 = (await clipHash(a2, 4))!, hb = (await clipHash(b, 4))!;
  assert.ok(ha && ha2 && hb); assert.ok(hashSimilarity(ha, ha2) > 0.9, String(hashSimilarity(ha, ha2))); assert.ok(hashSimilarity(ha, hb) < 0.8, String(hashSimilarity(ha, hb)));
});
test('dupCheck: identical later clip is auto-rejected with a note; same-series parts are not compared', async () => {
  const cfg = testConfig(); const st = new Store(':memory:'); const d = tmpDir(); const a = join(d, 'a.mp4'), a2 = join(d, 'a2.mp4');
  await vid(a, 'testsrc2=s=320x240:r=10'); await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-pix_fmt', 'yuv420p', a2]);
  st.exec(`INSERT INTO videos(path,fingerprint) VALUES ('x','f')`);
  for (const [i, sk] of [[1, null], [2, null], [3, 'S'], [4, 'S']] as const) { st.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,fingerprint,series_key) VALUES (1,0,4,.5,?,?)`, `c${i}`, sk); st.exec(`INSERT INTO clips(candidate_id,output_id) VALUES (?,?)`, i, `o${i}`); }
  await dupCheck(st, cfg, 1, 1, a, 4); const r = await dupCheck(st, cfg, 2, 2, a2, 4);
  assert.equal(r.similarTo, 1); assert.equal(st.get<{ review: string }>('SELECT review FROM clips WHERE id=2')!.review, 'rejected');
  await dupCheck(st, cfg, 3, 3, a, 4); await dupCheck(st, cfg, 4, 4, a2, 4); // same series: skipped against each other, but both match clip 1
  assert.ok(st.get<{ n: number }>('SELECT count(*) n FROM clip_fingerprints')!.n === 4);
});
test('freeUpSpace removes stale tmp + rejected clip files only', () => {
  const cfg = testConfig(); const st = new Store(':memory:'); mkdirSync(cfg.dirs.tmp, { recursive: true });
  const old = join(cfg.dirs.tmp, 'old.bin'); writeFileSync(old, 'x'); const past = new Date(Date.now() - 7200_000); utimesSync(old, past, past);
  const fresh = join(cfg.dirs.tmp, 'fresh.bin'); writeFileSync(fresh, 'x');
  const keep = join(tmpDir(), 'keep.mp4'), rej = join(tmpDir(), 'rej.mp4'); writeFileSync(keep, 'x'); writeFileSync(rej, 'x');
  st.exec(`INSERT INTO videos(path,fingerprint) VALUES ('x','f')`); st.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,fingerprint) VALUES (1,0,4,.5,'c')`);
  st.exec(`INSERT INTO clips(candidate_id,output_id,edited_path,review) VALUES (1,'k',?,'pending')`, keep); st.exec(`INSERT INTO clips(candidate_id,output_id,edited_path,review) VALUES (1,'r',?,'rejected')`, rej);
  const r = freeUpSpace(st, cfg, 10 ** 9); assert.ok(r.actions.length >= 2);
  assert.ok(!existsSync(old) && !existsSync(rej)); assert.ok(existsSync(fresh) && existsSync(keep));
});
test('musicVolume reaches the audio graph', () => {
  assert.match(buildAudioGraph({ hasAudio: true, targetLufs: -14, music: true, musicVolume: 0.5, duration: 10 }).graph!, /volume=0\.50/);
  assert.match(buildAudioGraph({ hasAudio: true, targetLufs: -14, music: true, duration: 10 }).graph!, /volume=0\.18/);
});
import { pickHook, prependHook } from '../src/edit/hookintro.ts';
import { probe } from '../src/media/probe.ts';
test('meme hook prepend: real ffmpeg, duration = hook + clip, size kept; picker deterministic', async () => {
  const d = tmpDir(); const clip = join(d, 'c.mp4'); const hook = join(d, 'hooks', 'h.mp4'); mkdirSync(join(d, 'hooks'));
  let r = await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=270x480:r=15', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '4', '-pix_fmt', 'yuv420p', '-shortest', clip]); assert.equal(r.code, 0, r.stderr);
  r = await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=25', '-t', '2', '-pix_fmt', 'yuv420p', hook]); assert.equal(r.code, 0, r.stderr); // hook WITHOUT audio
  assert.equal(pickHook(d, 3), hook); assert.equal(pickHook(join(d, 'x'), 1), null);
  const add = await prependHook(clip, hook, { width: 270, height: 480, fps: 15 }); assert.ok(Math.abs(add - 2) < 0.2);
  const p = await probe(clip); assert.equal(p.width, 270); assert.ok(Math.abs(p.duration - 6) < 0.5, String(p.duration)); assert.ok(p.hasAudio);
});
import { synthesize, ttsProviders } from '../src/tts/engine.ts';
test('tts: no provider → null (never throws); empty text → null', async () => {
  const p = await ttsProviders(); const d = tmpDir();
  assert.equal(await synthesize('   ', d), null);
  if (!p.edge && !p.piper) assert.equal(await synthesize('namaste dosto', d), null);
});
