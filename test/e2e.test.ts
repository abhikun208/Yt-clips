import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { qcClip } from '../src/edit/qc.ts';
import { seedJobs, work } from '../src/pipeline.ts';
import { sha256File } from '../src/util/hash.ts';
import { probe } from '../src/media/probe.ts';
import { checkDisk } from '../src/util/disk.ts';
import { makeThumbnail } from '../src/seo/thumbnail.ts';
import { testConfig, makeFixture, tmpDir } from './helpers.ts';

const small = { clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 3, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } };

test('real pipeline: ingest -> analyze -> render -> QC -> metadata/thumbnail; originals untouched; resumable', { timeout: 280_000 }, async () => {
  const cfg = testConfig(small); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'in.mp4'); await makeFixture(src, 24);
  const before = await sha256File(src);

  const r = await ingestLocal(s, cfg, src); assert.equal(r.duplicate, false);
  assert.equal((await ingestLocal(s, cfg, src)).duplicate, true, 'duplicate source detected');
  assert.equal(await sha256File(src), before, 'original input untouched');

  const a = await analyzeVideo(s, cfg, r.videoId);
  const v = s.get<{ intro_end: number; outro_start: number; state: string }>('SELECT intro_end, outro_start, state FROM videos WHERE id=?', r.videoId)!;
  assert.equal(v.state, 'ANALYZED'); assert.ok(Math.abs(v.intro_end - 4) < 0.6, `intro end ${v.intro_end}`); assert.ok(Math.abs(v.outro_start - 28) < 0.6, `outro start ${v.outro_start}`);
  assert.ok(a.candidates >= 1);
  const n1 = s.get<{ n: number }>('SELECT count(*) n FROM candidates')!.n;
  await analyzeVideo(s, cfg, r.videoId); // resume from checkpoint, must not duplicate candidates
  assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM candidates')!.n, n1, 'rerun adds no duplicate candidates');

  const cand = s.get<{ id: number; start_sec: number; end_sec: number }>('SELECT id, start_sec, end_sec FROM candidates ORDER BY score DESC')!;
  const out = await renderCandidate(s, cfg, cand.id, { title: 'Test', zoom: false, glow: false });
  assert.equal(out.qcPass, true); assert.ok(out.editedPath.includes('edited_shorts'));
  const m = await probe(out.editedPath); assert.equal(m.width, 270); assert.equal(m.height, 480);
  assert.ok(Math.abs(m.duration - (cand.end_sec - cand.start_sec)) < 0.6);
  const again = await renderCandidate(s, cfg, cand.id, {}); assert.equal(again.reused, true, 'idempotent: no duplicate render');
  const man = JSON.parse(readFileSync(join(cfg.dirs.manifests, `${out.outputId}.json`), 'utf8'));
  assert.equal(man.qc.pass, true); assert.ok(man.treatmentCoverage.coverage > 0); assert.equal(man.source.candidateId, cand.id);
  assert.ok(existsSync(join(cfg.dirs.rawClips, `${out.outputId}.mp4`)), 'raw clip kept separately');

  const th = await makeThumbnail(out.editedPath, join(cfg.dirs.thumbnails, 't.jpg'), 'TEST');
  assert.ok(th && th.width === 1280 && th.height === 720, 'thumbnail generated & validated');
  s.close();
});

test('job worker end-to-end (analyze->render->meta) and restart is a no-op', { timeout: 280_000 }, async () => {
  const cfg = testConfig(small); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'b.mp4'); await makeFixture(src, 24); await ingestLocal(s, cfg, src);
  seedJobs(s, cfg); const r1 = await work(s, cfg);
  assert.equal(r1.failed, 0, JSON.stringify(r1)); assert.ok(r1.done >= 3);
  const clips = s.all<{ qc_pass: number; metadata_json: string | null }>('SELECT qc_pass, metadata_json FROM clips');
  assert.ok(clips.length >= 1 && clips.every((c) => c.qc_pass === 1 && c.metadata_json));
  seedJobs(s, cfg); const r2 = await work(s, cfg); assert.equal(r2.done, 0, 'nothing re-done after restart');
  assert.equal(s.get<{ n: number }>("SELECT count(*) n FROM uploads")!.n, 0, 'pipeline never queues/uploads on its own');
  s.close();
});

test('re-analysis never duplicates already-rendered clips and keeps candidate counts stable', { timeout: 200_000 }, async () => {
  const cfg = testConfig(small); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'r.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src);
  await analyzeVideo(s, cfg, r.videoId);
  const first = s.get<{ id: number; start_sec: number; end_sec: number }>('SELECT id, start_sec, end_sec FROM candidates ORDER BY score DESC')!;
  await renderCandidate(s, cfg, first.id, { zoom: false, glow: false });
  await analyzeVideo(s, cfg, r.videoId, { force: true }); await analyzeVideo(s, cfg, r.videoId, { force: true });
  const rows = s.all<{ id: number; status: string; start_sec: number; end_sec: number }>('SELECT id, status, start_sec, end_sec FROM candidates');
  assert.equal(rows.filter((x) => x.status === 'rendered').length, 1);
  for (const x of rows.filter((y) => y.status === 'candidate')) assert.ok(Math.min(x.end_sec, first.end_sec) - Math.max(x.start_sec, first.start_sec) <= 0.5 * Math.min(x.end_sec - x.start_sec, first.end_sec - first.start_sec), 'no candidate overlaps the rendered clip by >50%');
  assert.equal(new Set(rows.map((x) => `${x.start_sec}-${x.end_sec}`)).size, rows.length, 'no duplicate windows');
  s.close();
});

test('bad inputs: missing, unsupported, corrupt, no-video', async () => {
  const cfg = testConfig(small); const s = new Store(cfg.dbPath); const d = tmpDir();
  await assert.rejects(ingestLocal(s, cfg, join(d, 'nope.mp4')), /not found/i);
  writeFileSync(join(d, 'a.txt'), 'x'); await assert.rejects(ingestLocal(s, cfg, join(d, 'a.txt')), /Unsupported/);
  writeFileSync(join(d, 'bad.mp4'), Buffer.from('not a video at all')); await assert.rejects(ingestLocal(s, cfg, join(d, 'bad.mp4')), /ffprobe failed/);
  assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM videos')!.n, 0, 'nothing registered for bad input');
  s.close();
});

test('QC really fails bad media (corrupt, wrong size) instead of rubber-stamping', async () => {
  const d = tmpDir(); const f = join(d, 'f.mp4'); await makeFixture(f, 6);
  const wrong = await qcClip(f, { width: 1080, height: 1920, duration: 14, requireAudio: true });
  assert.equal(wrong.pass, false); assert.ok(wrong.failures.some((x) => x.startsWith('resolution')));
  writeFileSync(join(d, 'c.mp4'), Buffer.from('garbage')); assert.equal((await qcClip(join(d, 'c.mp4'), { width: 1, height: 1, duration: 1, requireAudio: false })).pass, false);
});

test('low disk guard throws before rendering', () => {
  assert.throws(() => checkDisk(tmpDir(), 1e12), /LOW_DISK/);
});
