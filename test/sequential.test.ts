import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store, enqueue } from '../src/db.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';
import { pollSources, addYoutubeSource } from '../src/sources/youtube.ts';
import { channelBusy, maybeFreeSource } from '../src/sources/sequential.ts';
import { reframeParts } from '../src/edit/filters.ts';
import { run } from '../src/util/proc.ts';

const mkVideo = (s: Store, chan: number, path = '/x/a.mp4') => {
  s.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES ('youtube_video',?,?,1,'done',?)`, `https://youtube.com/watch?v=v${chan}${Math.random()}`, 't', JSON.stringify({ channelSource: chan }));
  const sid = s.get<{ id: number }>('SELECT max(id) id FROM sources')!.id;
  s.exec(`INSERT INTO videos(source_id, path, fingerprint, size, duration, width, height, fps, has_audio, state) VALUES (?,?,?,1,60,1920,1080,30,1,'ANALYZED')`, sid, path, 'fp' + Math.random());
  const vid = s.get<{ id: number }>('SELECT max(id) id FROM videos')!.id;
  s.exec(`INSERT INTO candidates(video_id, start_sec, end_sec, score, fingerprint, status) VALUES (?,0,30,0.9,?, 'candidate')`, vid, 'cf' + Math.random());
  return { vid, cand: s.get<{ id: number }>('SELECT max(id) id FROM candidates')!.id };
};

test('sequential lock: channel with unfinished clips is BUSY, becomes IDLE when all jobs are done, stale jobs never freeze it', () => {
  const cfg = testConfig(); const s = new Store(cfg.dbPath); const { id } = addYoutubeSource(s, 'https://www.youtube.com/@a', true);
  assert.equal(channelBusy(s, id).busy, false);
  const { cand } = mkVideo(s, id); enqueue(s, 'render', `render:${cand}`);
  const b = channelBusy(s, id); assert.equal(b.busy, true); assert.match(b.reason, /render/);
  s.exec(`UPDATE jobs SET updated_at=datetime('now','-7 hours')`); assert.equal(channelBusy(s, id).busy, false, 'job stuck > 6 h is ignored');
  s.exec(`UPDATE jobs SET updated_at=datetime('now'), state='DONE'`); assert.equal(channelBusy(s, id).busy, false);
  s.close();
});

test('poll: busy channel A downloads nothing (logged), idle channel B still downloads; A resumes once its clips are done', { timeout: 200_000 }, async () => {
  const bin = tmpDir(); const fx = join(bin, 'f.mp4'); await makeFixture(fx, 20); const ent = join(bin, 'e.json');
  writeFileSync(ent, JSON.stringify({ entries: [{ id: 'vidAAAAAAA1', title: 'A1', duration: 30 }] }));
  writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh\ncase "$*" in *--dump-single-json*) cat "${ent}"; exit 0;; esac\ndir=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && dir="\${a%/*}"; prev="$a"; last="$a"; done; id="\${last##*v=}"\nmkdir -p "$dir"; cp "${fx}" "$dir/$id.mp4"; echo "$dir/$id.mp4"\n`); chmodSync(join(bin, 'yt-dlp'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const cfg = testConfig({ youtube: { maxPerPoll: 1, maxDurationMin: 180 } }); const s = new Store(cfg.dbPath);
    const A = addYoutubeSource(s, 'https://www.youtube.com/@chanA', true).id;
    const { cand } = mkVideo(s, A); enqueue(s, 'render', `render:${cand}`); // A still has a clip being rendered
    s.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES ('youtube_video','https://www.youtube.com/watch?v=pendingA0001','a2',1,'pending',?)`, JSON.stringify({ channelSource: A, tries: 0, fresh: true }));
    const B = addYoutubeSource(s, 'https://www.youtube.com/@chanB', true).id;
    s.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES ('youtube_video','https://www.youtube.com/watch?v=pendingB0001','b1',1,'pending',?)`, JSON.stringify({ channelSource: B, tries: 0, fresh: true }));
    const st = (v: string) => s.get<{ status: string }>(`SELECT status FROM sources WHERE uri LIKE '%${v}'`)!.status;
    const r1 = await pollSources(s, cfg);
    assert.equal(st('pendingA0001'), 'pending', 'Channel A busy: blocked'); assert.equal(st('pendingB0001'), 'done', 'idle channel B jumped ahead'); assert.ok((r1.busy ?? 0) >= 1);
    s.exec(`UPDATE jobs SET state='DONE'`); await pollSources(s, cfg); assert.equal(st('pendingA0001'), 'done', 'A resumes after its clips are complete');
    cfg.automation.sequentialLock = false; s.close();
  } finally { process.env.PATH = old; }
});

test('free source after last clip: off by default, deletes only our own file once nothing is left', async () => {
  const cfg = testConfig(); const s = new Store(cfg.dbPath); mkdirSync(cfg.dirs.sources, { recursive: true }); const f = join(cfg.dirs.sources, 'v.mp4'); await makeFixture(f, 20);
  const { vid, cand } = mkVideo(s, 1, f); s.exec(`INSERT INTO clips(candidate_id, output_id, edited_path, qc_pass) VALUES (?, 'o1', '/e', 1)`, cand);
  assert.equal(maybeFreeSource(s, cfg, vid).why, 'off'); assert.ok(existsSync(f));
  cfg.storage.freeAfterRender = true; enqueue(s, 'meta', 'meta:1'); assert.equal(maybeFreeSource(s, cfg, vid).why, 'jobs baaki'); assert.ok(existsSync(f));
  s.exec(`UPDATE jobs SET state='DONE'`); const r = maybeFreeSource(s, cfg, vid); assert.equal(r.freed, true); assert.ok(!existsSync(f));
  const outside = join(tmpDir(), 'owner.mp4'); await makeFixture(outside, 20); const o = mkVideo(s, 1, outside); s.exec(`INSERT INTO clips(candidate_id, output_id, edited_path, qc_pass) VALUES (?, 'o2', '/e', 1)`, o.cand);
  assert.match(maybeFreeSource(s, cfg, o.vid).why, /owner/); assert.ok(existsSync(outside)); s.close();
});

test('facecam_top: facecam enlarged on top, whole gameplay in the middle, valid 1080x1920 output', async () => {
  const d = tmpDir(); const src = join(d, 's.mp4');
  assert.equal((await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=2:r=30', '-pix_fmt', 'yuv420p', src], { timeoutMs: 60_000 })).code, 0);
  const g = reframeParts({ inW: 1280, inH: 720, outW: 1080, outH: 1920, reframe: 'facecam_top', facecam: { x: 0.83, y: 0, w: 0.17, h: 0.34 }, topReserve: 0 } as never).parts[0]!;
  const out = join(d, 'o.mp4'); const r = await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-filter_complex', g, '-map', '[base]', '-frames:v', '10', '-pix_fmt', 'yuv420p', out], { timeoutMs: 60_000 }); assert.equal(r.code, 0, r.stderr);
  const p = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { timeoutMs: 20_000 }); assert.equal(p.stdout.trim(), '1080,1920');
});
