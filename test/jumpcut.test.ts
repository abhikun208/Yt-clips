import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { planCuts, mapCutTime, remapCuesCuts, cutFilter } from '../src/edit/jumpcut.ts';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { probe } from '../src/media/probe.ts';
import { run } from '../src/util/proc.ts';
import { testConfig, tmpDir } from './helpers.ts';

test('planCuts: only long silences, pause kept, edges protected, budget respected, short clips untouched', () => {
  const p = planCuts([{ start: 3, end: 5 }, { start: 8, end: 8.3 }, { start: 0.1, end: 1.5 }], 12)!;
  assert.equal(p.removed.length, 2); assert.ok(p.removed.every((r) => r.start >= 0.8), 'opening 0.8s never cut'); assert.ok(p.removed.some((r) => r.start > 3 && r.end < 5 && r.end - r.start > 1.5));
  assert.equal(planCuts([{ start: 3, end: 5 }], 6), null, 'clip < 8s untouched'); assert.equal(planCuts([], 20), null);
  const big = planCuts([{ start: 2, end: 6 }, { start: 8, end: 10 }, { start: 12, end: 13.5 }], 20, { maxFrac: 0.2 })!; assert.ok(big.saved <= 4.0 + 1e-6, `budget: ${big.saved}`);
  assert.equal(p.keep.length, 3); assert.ok(Math.abs(p.keep.reduce((x, k) => x + k.end - k.start, 0) - (12 - p.saved)) < 1e-6);
});
test('cut time map + caption re-timing are monotonic and drop words inside removed spans', () => {
  const p = planCuts([{ start: 4, end: 7 }], 15)!; const r = p.removed[0]!;
  assert.equal(mapCutTime(1, p), 1); assert.ok(Math.abs(mapCutTime(r.end, p) - r.start) < 1e-9); assert.ok(Math.abs(mapCutTime(15, p) - (15 - p.saved)) < 1e-9);
  let prev = -1; for (let t = 0; t <= 15; t += 0.2) { const x = mapCutTime(t, p); assert.ok(x >= prev); prev = x; }
  const cues = remapCuesCuts([{ start: 100, end: 110, text: 'a b c', words: [{ start: 101, end: 102, text: 'a' }, { start: r.start + 100 + 0.1, end: r.end + 100 - 0.1, text: 'ghost' }, { start: 108, end: 109, text: 'c' }] }], 100, p);
  assert.deepEqual(cues[0]!.words!.map((w) => w.text), ['a', 'c']); assert.ok(cues[0]!.words![1]!.start < 108 - p.saved + 0.01 + 100 - 100 + 100 - 100 + 0.5);
});
test('real ffmpeg: cutFilter removes the silent span, A/V stay equal length', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4');
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=12', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*220*t)*(between(t,0,4)+between(t,8,12))':s=44100:d=12", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const p = planCuts([{ start: 4, end: 8 }], 12)!; const out = join(d, 'o.mp4');
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex', cutFilter(p, true), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out]); assert.equal(r.code, 0, r.stderr);
  const pr = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', out]); const du = Object.fromEntries(pr.stdout.trim().split('\n').map((l) => { const [t, x] = l.split(','); return [t!, Number(x)]; }));
  assert.ok(Math.abs(du.video! - (12 - p.saved)) < 0.3, `video ${du.video} want ${12 - p.saved}`); assert.ok(Math.abs(du.audio! - du.video!) < 0.3);
});
test('renderCandidate with jump cuts: dead air removed in the edited short, manifest + progress bar recorded, QC passes, raw clip untouched', { timeout: 280_000 }, async () => {
  const cfg = testConfig({ edit: { width: 270, height: 480, preset: 'ultrafast', speedRamp: false, vfx: { particles: false, lightLeak: false } } }); const s = new Store(cfg.dbPath); const d = tmpDir(); const src = join(d, 'talk.mp4');
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=16', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*220*t)*(between(t,0,5)+between(t,9,16))':s=44100:d=16", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const r = await ingestLocal(s, cfg, src); s.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,category,fingerprint) VALUES (?,?,?,?,?,?)`, r.videoId, 0, 16, 0.9, 'general', 'fp-jc');
  const cand = s.get<{ id: number }>('SELECT id FROM candidates')!; const out = await renderCandidate(s, cfg, cand.id, { title: 'Test' });
  assert.equal(out.qcPass, true); const man = JSON.parse(readFileSync(join(cfg.dirs.manifests, `${out.outputId}.json`), 'utf8')) as { treatments: { dimension: string; applied: boolean; detail: string }[] };
  const jc = man.treatments.find((t) => t.dimension === 'jump_cuts')!; assert.ok(jc.applied, jc.detail); assert.ok(man.treatments.find((t) => t.dimension === 'progress_bar')!.applied);
  const em = await probe(out.editedPath); const raw = await probe(join(cfg.dirs.rawClips, `${out.outputId}.mp4`)); assert.ok(raw.duration > 15.5 && em.duration < raw.duration - 2, `edited ${em.duration} raw ${raw.duration}`);
});
