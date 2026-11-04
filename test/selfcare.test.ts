import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store, enqueue, claim } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { sweepTmp, sweepOrphans, diskUsedPct } from '../src/ops/selfcare.ts';
import { checkTranscript, isJunkCue } from '../src/analysis/sanity.ts';
import { parseSttJson } from '../src/analysis/stt.ts';
import { tmpDir, testConfig } from './helpers.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { work } from '../src/pipeline.ts';
import { run } from '../src/util/proc.ts';
import { recentLogs } from '../src/util/log.ts';

function cfgFor(d: string) { const c = loadConfig(process.cwd(), { dataDir: d }); mkdirSync(c.dirs.tmp, { recursive: true }); return c; }

test('temp GC: old leftovers of a crashed render are removed, fresh files and files of a running job are kept', () => {
  const d = tmpDir(); const cfg = cfgFor(d); const store = new Store(join(d, 'q.sqlite'));
  const old = join(cfg.dirs.tmp, 'stt_old.wav'), fresh = join(cfg.dirs.tmp, 'stt_new.wav'), mid = join(cfg.dirs.tmp, 'mid.mp4');
  for (const f of [old, fresh, mid]) writeFileSync(f, 'x');
  const t = (h: number) => new Date(Date.now() - h * 3600_000); utimesSync(old, t(30), t(30)); utimesSync(mid, t(5), t(5));
  assert.equal(sweepTmp(store, cfg), 2); assert.ok(!existsSync(old) && !existsSync(mid) && existsSync(fresh)); // idle: > 3 h goes
  writeFileSync(mid, 'x'); utimesSync(mid, t(5), t(5)); enqueue(store, 'render', 'render:1'); claim(store);
  assert.equal(sweepTmp(store, cfg), 0); assert.ok(existsSync(mid), 'a 5 h old file may belong to a long STT job that is RUNNING');
  assert.ok(diskUsedPct(d) >= 0);
});

test('orphan sweep: a stray ffmpeg-like process of ours (old, not our child) is killed; our own child and foreign processes are not', async () => {
  const d = tmpDir(); const cfg = cfgFor(d); const marker = join(d, 'orphan-marker');
  // a process named "python3" would be needed to match; build a fake /proc tree instead so the test is deterministic and harmless
  const proc = join(d, 'fakeproc'); mkdirSync(join(proc, 'self'), { recursive: true }); writeFileSync(join(proc, 'uptime'), '10000.00 0');
  const mk = (pid: number, args: string[], startTicks: number) => { mkdirSync(join(proc, String(pid))); writeFileSync(join(proc, String(pid), 'cmdline'), args.join('\0') + '\0'); writeFileSync(join(proc, String(pid), 'stat'), `${pid} (ffmpeg) S ` + Array.from({ length: 19 }, (_, i) => (i === 18 ? String(startTicks) : '0')).join(' ')); };
  // stat after ") ": index 19 is starttime -> we wrote 3 header fields? keep format simple: state + 18 zeros + start
  mk(4001, ['/usr/bin/ffmpeg', '-i', join(d, 'raw_clips', 'a.mp4')], 100);          // started at 1 s of uptime -> 9999 s old, ours -> kill
  mk(4002, ['/usr/bin/ffmpeg', '-i', join(d, 'x.mp4')], 999_000);                    // started "recently" (uptime 10000 s, start 9990 s) -> too young
  mk(4003, ['/usr/bin/ffmpeg', '-i', '/somewhere/else.mp4'], 100);                   // not using our data dir -> foreign, keep
  mk(4004, ['/usr/bin/node', join(d, 'srv.js')], 100);                               // not an engine binary -> keep
  const killed: number[] = []; const out = sweepOrphans(cfg, 600, { proc, kill: (p) => { killed.push(p); } });
  assert.deepEqual(out, [4001].filter((p) => killed.includes(p))); assert.deepEqual(killed.sort(), [4001]); void marker; void spawn; void readFileSync;
});

test('transcript self-check: decoder loops removed, junk detected, low-confidence segments counted', () => {
  const cues = [{ start: 0, end: 1, text: 'namaste dosto' }, ...[1, 2, 3, 4].map((i) => ({ start: i, end: i + 1, text: 'Thank you.' })), { start: 6, end: 7, text: 'a a a a a a a a' }, { start: 7, end: 8, text: 'ok', conf: { logprob: -1.8, no_speech: 0.1 } }];
  const r = checkTranscript(cues); assert.equal(r.removed, 2); assert.ok(r.bad >= 2); assert.ok(isJunkCue({ start: 0, end: 1, text: 'x'.repeat(30) })); assert.ok(!isJunkCue({ start: 0, end: 1, text: 'aaj ka video', conf: { logprob: -0.3, no_speech: 0.01 } }));
  assert.equal(checkTranscript([{ start: 0, end: 1, text: 'sab theek hai' }]).badRatio, 0);
});

test('faster-whisper confidence survives parsing (avg_logprob / no_speech_prob)', () => {
  const j = JSON.stringify({ language: 'hi', segments: [{ start: 0, end: 2, text: 'namaste', conf: { logprob: -0.4, no_speech: 0.02 }, words: [] }] });
  assert.deepEqual(parseSttJson(j).cues[0]!.conf, { logprob: -0.4, no_speech: 0.02 });
});

test('Auto-QA: a render that fails the measured checks (all-black video) is retried twice with safe settings, then given up - the job still completes', { timeout: 280_000 }, async () => {
  const cfg = testConfig({ edit: { width: 270, height: 480, preset: 'ultrafast' } }); const store = new Store(cfg.dbPath); const src = join(tmpDir(), 'black.mp4');
  const ff = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=480x270:r=25:d=10', '-f', 'lavfi', '-i', 'sine=f=440:d=10', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', src]); assert.equal(ff.code, 0, ff.stderr);
  const r = await ingestLocal(store, cfg, src); store.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,category,fingerprint) VALUES (?,?,?,?,?,?)`, r.videoId, 1, 9, 0.9, 'general', 'fp-qc');
  const cand = store.get<{ id: number }>('SELECT id FROM candidates')!; enqueue(store, 'render', `render:${cand.id}`);
  const before = recentLogs(300, 'warn').filter((l) => l.msg === 'render failed QC - retrying with safe settings').length;
  const res = await work(store, cfg, { maxJobs: 1 }); assert.equal(res.done, 1, JSON.stringify(res));
  const retries = recentLogs(300, 'warn').filter((l) => l.msg === 'render failed QC - retrying with safe settings').length - before; assert.equal(retries, 2);
  assert.equal(store.get<{ state: string }>('SELECT state FROM clips WHERE candidate_id=?', cand.id)!.state, 'QC_FAILED');
});
