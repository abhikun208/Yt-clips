import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store, enqueue } from '../src/db.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';
import { run } from '../src/util/proc.ts';
import { sweepSources, channelBusy } from '../src/sources/sequential.ts';
import { refetchSource } from '../src/sources/refetch.ts';
import { detectFacecam } from '../src/edit/facecamdetect.ts';
import { loadConfig } from '../src/config.ts';

const mkv = (s: Store, path: string, kind = 'youtube_video', chan = 0) => {
  s.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES (?,?,?,1,'done',?)`, kind, `https://www.youtube.com/watch?v=abcdefghij${Math.floor(Math.random() * 1e6)}`, 't', JSON.stringify(chan ? { channelSource: chan } : {}));
  const sid = s.get<{ id: number }>('SELECT max(id) id FROM sources')!.id;
  s.exec(`INSERT INTO videos(source_id, path, fingerprint, size, duration, width, height, fps, has_audio, state) VALUES (?,?,?,1,20,640,360,30,1,'ANALYZED')`, sid, path, 'fp' + Math.random());
  const vid = s.get<{ id: number }>('SELECT max(id) id FROM videos')!.id;
  s.exec(`INSERT INTO candidates(video_id, start_sec, end_sec, score, fingerprint, status) VALUES (?,0,10,0.9,?, 'candidate')`, vid, 'c' + Math.random());
  const cand = s.get<{ id: number }>('SELECT max(id) id FROM candidates')!.id;
  s.exec(`INSERT INTO clips(candidate_id, output_id, edited_path, qc_pass) VALUES (?,?, '/e', 1)`, cand, 'o' + Math.random());
  const clip = s.get<{ id: number }>('SELECT max(id) id FROM clips')!.id; s.exec(`INSERT INTO uploads(clip_id, platform, idempotency_key, state) VALUES (?, 'youtube_shorts', ?, 'UPLOADED')`, clip, 'k' + Math.random());
  return { vid, clip, cand, up: s.get<{ id: number }>('SELECT max(id) id FROM uploads')!.id };
};

test('autoCleanup: source deleted only when every clip is PUBLISHED (or QC-failed); review-waiting clips keep it; local uploads and foreign files are never touched', async () => {
  const cfg = testConfig(); const s = new Store(cfg.dbPath); mkdirSync(cfg.dirs.sources, { recursive: true });
  const f = join(cfg.dirs.sources, 'a.mp4'); await makeFixture(f, 20); const { vid, up } = mkv(s, f);
  assert.deepEqual(sweepSources(s, cfg), { freed: 0, mb: 0 }); assert.ok(existsSync(f), 'autoCleanup off (not a phone): nothing happens');
  cfg.storage.autoCleanup = true; assert.equal(sweepSources(s, cfg).freed, 0); assert.ok(existsSync(f), 'clip still waiting for publish');
  s.exec(`UPDATE uploads SET state='PUBLISHED' WHERE id=?`, up); enqueue(s, 'render', 'render:999'); // unrelated job must not matter
  const r = sweepSources(s, cfg); assert.equal(r.freed, 1); assert.ok(!existsSync(f)); assert.ok(s.get('SELECT 1 FROM kv WHERE k=?', `local:pruned:${vid}`));
  const g = join(cfg.dirs.sources, 'local.mp4'); await makeFixture(g, 20); const l = mkv(s, g, 'local_file'); s.exec(`UPDATE uploads SET state='PUBLISHED'`); sweepSources(s, cfg); assert.ok(existsSync(g), 'uploaded originals are never deleted'); void l;
  const o = join(tmpDir(), 'foreign.mp4'); await makeFixture(o, 20); mkv(s, o); s.exec(`UPDATE uploads SET state='PUBLISHED'`); sweepSources(s, cfg); assert.ok(existsSync(o), 'file outside our sources folder is never deleted');
  s.close();
});

test('autoCleanup: a clip stuck in review for sourceKeepDays no longer holds the source', async () => {
  const cfg = testConfig(); cfg.storage.autoCleanup = true; const s = new Store(cfg.dbPath); mkdirSync(cfg.dirs.sources, { recursive: true });
  const f = join(cfg.dirs.sources, 'r.mp4'); await makeFixture(f, 20); const { clip } = mkv(s, f); assert.equal(sweepSources(s, cfg).freed, 0);
  s.exec(`UPDATE clips SET created_at=datetime('now','-9 days') WHERE id=?`, clip); assert.equal(sweepSources(s, cfg).freed, 1); assert.ok(!existsSync(f)); s.close();
});

test('refetch: a cleaned-up YouTube source is downloaded again to the same path; wrong-length file is rejected; uploads cannot be re-fetched', async () => {
  const bin = tmpDir(); const good = join(bin, 'g.mp4'); await makeFixture(good, 20); const bad = join(bin, 'b.mp4'); await makeFixture(bad, 30);
  writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh\nfor a in "$@"; do last="$a"; done; dir=""; prev=""; out=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\ndir="\${out%/*}"; mkdir -p "$dir"; f="$dir/$(basename "$out" | sed 's/%(ext)s/mp4/')"; if [ -f "${bin}/use_bad" ]; then cp "${bad}" "$f"; else cp "${good}" "$f"; fi; echo "$f"\n`); chmodSync(join(bin, 'yt-dlp'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const cfg = testConfig(); const s = new Store(cfg.dbPath); mkdirSync(cfg.dirs.sources, { recursive: true }); const p = join(cfg.dirs.sources, 'x.mp4');
    const { vid } = mkv(s, p); const gd = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', good], { timeoutMs: 20_000 })).stdout.trim()); s.exec(`UPDATE videos SET duration=?`, gd); s.exec(`INSERT INTO kv(k,v) VALUES (?, 'x')`, `local:pruned:${vid}`);
    writeFileSync(join(bin, 'use_bad'), ''); await assert.rejects(refetchSource(s, cfg, vid), /length alag/); assert.ok(!existsSync(p));
    await run('rm', ['-f', join(bin, 'use_bad')]); const r = await refetchSource(s, cfg, vid); assert.ok(existsSync(p)); assert.ok(r.mb > 0); assert.equal(s.get('SELECT 1 FROM kv WHERE k=?', `local:pruned:${vid}`), undefined);
    const l = mkv(s, join(cfg.dirs.sources, 'u.mp4'), 'local_file'); await assert.rejects(refetchSource(s, cfg, l.vid), /upload/); s.close();
  } finally { process.env.PATH = old; }
});

test('auto facecam: finds a box in a corner (top-right, bottom-left), finds nothing in a plain game', { timeout: 120_000 }, async () => {
  const d = tmpDir(); const mk = async (name: string, ov: string) => { const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=1280x720:rate=10']; if (ov) args.push('-f', 'lavfi', '-i', 'testsrc2=s=240x300:r=10', '-f', 'lavfi', '-i', 'color=c=0x101010:s=250x310:r=10', '-filter_complex', ov); args.push('-t', '20', '-pix_fmt', 'yuv420p', join(d, name)); const r = await run('ffmpeg', args, { timeoutMs: 90_000 }); assert.equal(r.code, 0, r.stderr); };
  await mk('tr.mp4', '[0][2]overlay=W-w-4:4[a];[a][1]overlay=W-w-9:9'); await mk('bl.mp4', '[0][2]overlay=4:H-h-4[a];[a][1]overlay=9:H-h-9'); await mk('plain.mp4', '');
  const tr = await detectFacecam(join(d, 'tr.mp4'), 20); assert.equal(tr.zone, 'tr'); assert.ok(tr.confidence >= 0.7 && tr.rect!.w > 0.1 && tr.rect!.w < 0.3);
  assert.equal((await detectFacecam(join(d, 'bl.mp4'), 20)).zone, 'bl'); const pl = await detectFacecam(join(d, 'plain.mp4'), 20); assert.equal(pl.zone, null);
  assert.equal((await detectFacecam(join(d, 'missing.mp4'), 20)).zone, null, 'unreadable file = no facecam, never a crash');
});

test('parallelism: YT_CLIPS_PARALLEL_JOBS sets the lanes (phone default 1); maxActiveVideosPerChannel lets a channel run 2 videos', () => {
  const dflt = loadConfig(tmpDir(), { dataDir: tmpDir() }); assert.equal(dflt.resources.renderConcurrency, 1);
  process.env.YT_CLIPS_PARALLEL_JOBS = '3'; try { assert.equal(loadConfig(tmpDir(), { dataDir: tmpDir() }).resources.renderConcurrency, 3); } finally { delete process.env.YT_CLIPS_PARALLEL_JOBS; }
  const cfg = testConfig(); const s = new Store(cfg.dbPath); s.exec(`INSERT INTO sources(kind, uri, title, authorized, status) VALUES ('youtube_channel','https://youtube.com/@c','c',1,'active')`); const ch = s.get<{ id: number }>('SELECT max(id) id FROM sources')!.id;
  const a = mkv(s, '/x/1.mp4', 'youtube_video', ch); enqueue(s, 'render', `render:${a.cand}`); assert.equal(channelBusy(s, ch, 1).busy, true); assert.equal(channelBusy(s, ch, 2).busy, false, '1 of 2 active: another video may start');
  const b = mkv(s, '/x/2.mp4', 'youtube_video', ch); enqueue(s, 'render', `render:${b.cand}`); assert.equal(channelBusy(s, ch, 2).busy, true); s.close();
});
