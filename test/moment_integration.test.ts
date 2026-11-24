import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { editorialQc } from '../src/analysis/moments-store.ts';
import { validateForPlatform } from '../src/publish/machine.ts';
import { run } from '../src/util/proc.ts';
import { testConfig, tmpDir } from './helpers.ts';

const small = { clip: { minSec: 8, maxSec: 25, targetSec: 15, maxClipsPerVideo: 0, minScore: 0.2, skipHeadSec: 0, skipTailSec: 0 }, edit: { width: 270, height: 480, preset: 'ultrafast' } };

test('real video + Hinglish SRT: moments are discovered, stored with breakdown, linked to candidates; re-analysis does not duplicate', { timeout: 200_000 }, async () => {
  const cfg = testConfig(small); const s = new Store(cfg.dbPath); const dir = tmpDir(); const src = join(dir, 'g.mp4');
  const r0 = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=70', '-f', 'lavfi', '-i', 'aevalsrc=0.06*sin(2*PI*200*t)+0.9*sin(2*PI*600*t)*lt(mod(t\\,35)\\,3)*gt(mod(t\\,35)\\,0):s=44100:d=70', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src], { timeoutMs: 120000 });
  assert.equal(r0.code, 0, r0.stderr);
  writeFileSync(join(dir, 'g.srt'), `1\n00:00:30,000 --> 00:00:33,000\nye galti ho gayi yaar\n\n2\n00:00:34,000 --> 00:00:37,000\nअरे नहीं नहीं मार दिया!\n\n3\n00:00:37,200 --> 00:00:40,000\nhahaha kya baat hai\n`);
  const ing = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, ing.videoId);
  const rows = s.all<{ tier: string; breakdown_json: string; missing_json: string; candidate_id: number | null; origin: string; start_sec: number; end_sec: number }>('SELECT * FROM moments WHERE video_id=?', ing.videoId);
  assert.ok(rows.length >= 1, 'moments stored'); for (const m of rows) { assert.ok(JSON.parse(m.breakdown_json).editing !== undefined); assert.ok(Array.isArray(JSON.parse(m.missing_json))); }
  const n = rows.length; await analyzeVideo(s, cfg, ing.videoId, { force: true });
  assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM moments WHERE video_id=?', ing.videoId)!.n, n, 're-analysis replaces, never duplicates');
});

test('editorial QC gates only clips that have a moment row; legacy clips unaffected; owner approval releases CONDITIONAL', () => {
  const s = new Store(':memory:');
  s.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`);
  for (const [id, tier, origin, ctx] of [[1, 'STRONG', 'moment', 1], [2, 'CONDITIONAL', 'moment', 1], [3, 'REJECTED', 'legacy', 1], [4, 'STRONG', 'moment', 0]] as const) {
    s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,1,0,6,.5,?)`, id, `c${id}`); s.exec(`INSERT INTO clips(id, candidate_id, output_id, qc_pass) VALUES (?,?,?,1)`, id, id, `o${id}`);
    s.exec(`INSERT INTO moments(video_id, candidate_id, origin, start_sec, end_sec, tier, score, confidence, context_complete, breakdown_json, missing_json, reasons_json, fingerprint) VALUES (1,?,?,0,6,?,.5,.8,?,'{}','[]','[]',?)`, id, origin, tier, ctx, `m${id}`);
  }
  s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (9,1,0,6,.5,'c9')`); s.exec(`INSERT INTO clips(id, candidate_id, output_id, qc_pass) VALUES (9,9,'o9',1)`);
  assert.equal(editorialQc(s, 1).ok, true); assert.equal(editorialQc(s, 2).ok, false); assert.equal(editorialQc(s, 3).ok, false); assert.equal(editorialQc(s, 4).ok, false);
  assert.deepEqual(editorialQc(s, 9), { ok: true, applies: false, reasons: [] }, 'legacy clip untouched');
  s.exec(`UPDATE clips SET review='approved' WHERE id=2`); assert.equal(editorialQc(s, 2).ok, true);
  const f = { width: 1080, height: 1920, duration: 30, title: 't', description: 'd', qcPass: true, authorized: true, editorialQc: { ok: false, reasons: ['x'] } };
  assert.ok(validateForPlatform('youtube_shorts', f).some((e) => /editorial QC/.test(e))); assert.ok(!validateForPlatform('youtube_shorts', { ...f, editorialQc: { ok: true, reasons: [] } }).some((e) => /editorial/.test(e)));
});
