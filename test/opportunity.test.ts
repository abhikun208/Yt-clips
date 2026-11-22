import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { opportunity, rejectLowOpportunity, maxSimilarity, PARTS, type OppInput } from '../src/analysis/opportunity.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';

const strong: OppInput = { signals: { peak: 0.95, energy: 0.7, variance: 0.3, pace: 0.7, complete: 1, hookLine: 0.9, payoff: 1, gaming: 0.8, external: 0 }, transcript: 'Wait, how did he survive that? Nobody expected the last second clutch, it was insane and he won the whole round.', hook: 'Wait, how did he survive that?', category: 'gaming_moment', duration: 18 };
const weak: OppInput = { signals: { peak: 0.1, energy: 0.1, variance: 0.02, pace: 0, complete: 0, hookLine: 0, payoff: 0 }, transcript: 'um so yeah and then we just kind of', hook: 'um so yeah', category: 'general', duration: 45 };

test('opportunity: 13 sub-scores with basis + reason; strong clip scores far above a weak one', () => {
  const a = opportunity(strong), b = opportunity(weak); assert.deepEqual(Object.keys(a.parts), [...PARTS]); assert.equal(PARTS.length, 13);
  for (const k of PARTS) { assert.ok(['MEASURED', 'HEURISTIC', 'UNAVAILABLE'].includes(a.parts[k].basis)); assert.ok(a.parts[k].reason.length > 3, k); }
  assert.ok(a.score! > 65 && b.score! < 35 && a.score! - b.score! > 30, `strong ${a.score} weak ${b.score}`); assert.ok(a.reasons.length > 0);
});
test('opportunity: evidence we do not have is UNAVAILABLE and left out of the average (never invented)', () => {
  const o = opportunity(strong); for (const k of ['originality', 'audienceFit', 'competition'] as const) { assert.equal(o.parts[k].value, null); assert.ok(o.unavailable.includes(k)); }
  const withCtx = opportunity(strong, { similarityToPast: 0.9, categoryPrior: 1.2, competition: 0.5 }); assert.equal(withCtx.parts.originality.value, 10); assert.equal(withCtx.parts.audienceFit.value, 100); assert.equal(withCtx.parts.competition.value, 50); assert.deepEqual(withCtx.unavailable, []);
  assert.ok(withCtx.score! < o.score!, 'a copy of earlier clips lowers the score');
  const none = opportunity({ signals: {}, transcript: '', hook: '', category: 'general', duration: 30 }); assert.ok(none.unavailable.length >= 6);
});
test('rejectLowOpportunity drops only scored-below-threshold clips; no score (not enough evidence) is kept', () => {
  const noEvidence: OppInput = { signals: {}, transcript: '', hook: '', category: 'general', duration: 30 };
  const r = rejectLowOpportunity([strong, weak, noEvidence], 50); const o = opportunity(noEvidence); assert.equal(r.dropped.length, o.score !== null && o.score < 50 ? 2 : 1); assert.ok(r.keep.includes(strong)); assert.ok(r.dropped.some((d) => d.c === weak));
  assert.equal(maxSimilarity('same words here again and again please', ['same words here again and again please']) > 0.9, true); assert.equal(maxSimilarity('abc', []), 0);
});
test('analyzer: stores a score + parts for every candidate; opportunityMin never rejects a clip that has no usable evidence (silent fixture => score null => kept)', { timeout: 150_000 }, async () => {
  const mk = (min?: number) => testConfig({ clip: { minSec: 5, maxSec: 8, targetSec: 6, maxClipsPerVideo: 0, minScore: 0.01, ...(min ? { opportunityMin: min } : {}) } } as never);
  const cfg = mk(); const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'o.mp4'); await makeFixture(src, 60); const r = await ingestLocal(s, cfg, src);
  const a = await analyzeVideo(s, cfg, r.videoId, { force: true }); assert.ok(a.candidates > 0);
  const rows = s.all<{ score: number | null; parts_json: string }>('SELECT o.score, o.parts_json FROM candidate_opportunity o JOIN candidates c ON c.id=o.candidate_id WHERE c.status=\'candidate\''); assert.equal(rows.length, a.candidates);
  const p = JSON.parse(rows[0]!.parts_json) as { parts: Record<string, { basis: string }>; unavailable: string[] }; assert.equal(Object.keys(p.parts).length, 13); assert.ok(p.unavailable.includes('competition')); console.log('# stored example:', rows[0]!.score, p.unavailable.join(','));
  const cfg2 = mk(101); const s2 = new Store(cfg2.dbPath); const src2 = join(tmpDir(), 'o2.mp4'); await makeFixture(src2, 60); const r2 = await ingestLocal(s2, cfg2, src2); const z = await analyzeVideo(s2, cfg2, r2.videoId, { force: true }); assert.equal(z.candidates, a.candidates, 'no transcript => not enough evidence for a score => nothing is rejected on absence of evidence'); assert.ok(s2.all<{ score: number | null }>('SELECT score FROM candidate_opportunity').every((x) => x.score === null), 'stored score is NULL, not a made-up number');
});
