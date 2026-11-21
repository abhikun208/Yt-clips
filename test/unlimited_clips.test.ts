import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { cleanConfig } from '../src/channels.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';

test('no arbitrary per-video clip cap: default is 0 (unlimited); channel + request accept 0 and values above 12', () => {
  assert.equal(testConfig().clip.maxClipsPerVideo, 0);
  const ok = cleanConfig({ maxClips: 40 }, () => true) as Record<string, unknown>; assert.equal(ok.maxClips, 40);
  const zero = cleanConfig({ maxClips: 0 }, () => true) as Record<string, unknown>; assert.equal(zero.maxClips, 0);
  assert.throws(() => cleanConfig({ maxClips: -1 }, () => true), /maxClips/);
});

test('unlimited (0): a cap of 1 gives 1 clip, 0 gives every qualifying distinct non-overlapping moment', { timeout: 120_000 }, async () => {
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 8, targetSec: 6, maxClipsPerVideo: 0, minScore: 0.01 } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'u.mp4'); await makeFixture(src, 120); const r = await ingestLocal(s, cfg, src);
  const one = await analyzeVideo(s, cfg, r.videoId, { force: true, maxClips: 1 }); assert.equal(one.candidates, 1);
  const all = await analyzeVideo(s, cfg, r.videoId, { force: true, maxClips: 0 });
  assert.ok(all.candidates > 12, `the old cap of 12 must be gone, got ${all.candidates}`);
  const again = await analyzeVideo(s, cfg, r.videoId, { force: true, maxClips: 0 });
  assert.equal(again.candidates, all.candidates, 'restart/re-analysis must not create duplicate candidates');
  const dup = s.get<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT fingerprint FROM candidates GROUP BY fingerprint HAVING COUNT(*)>1)')!.n; assert.equal(dup, 0);
});
