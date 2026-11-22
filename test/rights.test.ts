import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rightsScreen } from '../src/analysis/rights.ts';
import { Store } from '../src/db.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { join } from 'node:path';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';

const base = { duration: 30, ownNames: ['Main', 'main'] };
test('clean talking clip is ok', () => {
  const r = rightsScreen({ ...base, transcript: Array(60).fill('word').join(' ') });
  assert.equal(r.decision, 'ok'); assert.deepEqual(r.flags, []);
});
test('other creator handle -> review; own handle ignored', () => {
  const r = rightsScreen({ ...base, transcript: 'follow @RandomCreator for more ' + Array(40).fill('x').join(' ') });
  assert.equal(r.decision, 'review'); assert.ok(r.flags.includes('other_handle')); assert.deepEqual(r.handles, ['randomcreator']);
  assert.deepEqual(rightsScreen({ ...base, transcript: 'hi @main ' + Array(40).fill('x').join(' ') }).handles, []);
});
test('credit/copyright wording -> review', () => {
  const r = rightsScreen({ ...base, transcript: 'all rights reserved ' + Array(40).fill('x').join(' ') });
  assert.equal(r.decision, 'review'); assert.ok(r.flags.includes('credit_text'));
});
test('no speech -> note only, never review; states its limit', () => {
  const r = rightsScreen({ ...base, transcript: '' });
  assert.equal(r.decision, 'note'); assert.deepEqual(r.flags, ['no_commentary']); assert.match(r.limit, /no OCR/);
});

test('analyzer: writes a rights decision row for every candidate (silent fixture => note/ok, never rejected)', { timeout: 150_000 }, async () => {
  const cfg = testConfig({ clip: { minSec: 5, maxSec: 8, targetSec: 6, maxClipsPerVideo: 0, minScore: 0.01 } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'r.mp4'); await makeFixture(src, 60); const r = await ingestLocal(s, cfg, src); const a = await analyzeVideo(s, cfg, r.videoId, { force: true });
  const rows = s.all<{ decision: string; flags_json: string }>("SELECT r.decision, r.flags_json FROM candidate_rights r JOIN candidates c ON c.id=r.candidate_id WHERE c.status='candidate'");
  assert.equal(rows.length, a.candidates); assert.ok(rows.every((x) => ['ok', 'note'].includes(x.decision)));
});
