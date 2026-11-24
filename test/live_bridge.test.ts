import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { extractEnds, makeBridge } from '../src/watcher/live-bridge.ts';
import { probe } from '../src/media/probe.ts';
import { run } from '../src/util/proc.ts';
import { testConfig, tmpDir } from './helpers.ts';

async function chunk(out: string, d: number, f: number) {
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=15:d=${d}`, '-f', 'lavfi', '-i', `sine=f=${f}:d=${d}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], { timeoutMs: 90000 });
  assert.equal(r.code, 0, r.stderr);
}

test('real ffmpeg: tail of chunk A + head of chunk B becomes one bridge video with the seam in the middle', { timeout: 120_000 }, async () => {
  const dir = tmpDir(); const a = join(dir, 'a.mp4'), b = join(dir, 'b.mp4'); await chunk(a, 40, 220); await chunk(b, 40, 440);
  const ea = await extractEnds(a, dir, 'a'), eb = await extractEnds(b, dir, 'b'); assert.ok(ea && eb);
  const out = join(dir, 'bridge.mp4'); const br = await makeBridge(ea!, eb!, out); assert.ok(br);
  const m = await probe(out); assert.ok(m.duration > 34 && m.duration < 44, `duration ${m.duration}`); assert.ok(Math.abs(br!.seam - 20) < 2.5, `seam ${br!.seam}`);
});

test('analyzer on a bridge video keeps only moments that cross the seam and never turns it into one whole clip', { timeout: 200_000 }, async () => {
  const cfg = testConfig({ clip: { minSec: 8, maxSec: 25, targetSec: 15, maxClipsPerVideo: 0, minScore: 0.2, skipHeadSec: 0, skipTailSec: 0 }, edit: { width: 270, height: 480, preset: 'ultrafast' } }); const s = new Store(cfg.dbPath); const dir = tmpDir(); const f = join(dir, 'br.mp4'); await chunk(f, 44, 300);
  writeFileSync(join(dir, 'br.srt'), `1\n00:00:16,000 --> 00:00:19,000\nye galti ho gayi yaar\n\n2\n00:00:20,000 --> 00:00:23,000\nअरे नहीं नहीं मार दिया!\n\n3\n00:00:23,200 --> 00:00:26,000\nhahaha kya baat hai\n\n4\n00:00:02,000 --> 00:00:05,000\nbilkul alag baat hai ye\n`);
  const v = await ingestLocal(s, cfg, f); s.exec('INSERT INTO kv(k, v) VALUES (?,?)', `live:bridge:${v.videoId}`, JSON.stringify({ seam: 22, seq: 2 }));
  await analyzeVideo(s, cfg, v.videoId);
  for (const c of s.all<{ start_sec: number; end_sec: number }>('SELECT start_sec, end_sec FROM candidates WHERE video_id=?', v.videoId)) assert.ok(c.start_sec < 20.5 && c.end_sec > 23.5, `candidate ${c.start_sec}-${c.end_sec} must cross the seam`);
  assert.ok(s.get<{ n: number }>('SELECT count(*) n FROM moments WHERE video_id=?', v.videoId)!.n >= 1, 'the seam moment is found (not vacuous)');
  for (const m of s.all<{ start_sec: number; end_sec: number }>('SELECT start_sec, end_sec FROM moments WHERE video_id=?', v.videoId)) assert.ok(m.start_sec < 20.5 && m.end_sec > 23.5);
});
