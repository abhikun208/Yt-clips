import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { testConfig } from './helpers.ts';
import { collectObservations, analyze, proposeChanges, applyChange, revertChange, evaluateChange, learningReport, type Obs } from '../src/analytics/learn.ts';
import { getChannel, mainChannel } from '../src/channels.ts';

const NOW = Date.parse('2026-11-21T00:00:00Z');
let seq = 0;
/** one published clip + a measured snapshot; views=null -> unavailable */
function add(s: Store, o: { dur: number; views: number | null; cat?: string; pubDaysAgo?: number; pubAt?: string }): void {
  const i = ++seq; const ch = mainChannel(s).id;
  s.exec(`INSERT OR IGNORE INTO videos(id, path, fingerprint, state) VALUES (1,'/x.mp4','fp','ANALYZED')`);
  s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, category, fingerprint) VALUES (?,1,0,?,0.9,?,?)`, i, o.dur, o.cat ?? 'funny', 'c' + i);
  s.exec(`INSERT INTO clips(id, candidate_id, output_id, state) VALUES (?,?,?,'RENDERED')`, i, i, 'o' + i);
  s.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, remote_id, channel_id) VALUES (?, 'youtube_shorts','PUBLISHED',?,?,?)`, i, 'k' + i, 'r' + i, ch);
  const pub = o.pubAt ?? new Date(NOW - (o.pubDaysAgo ?? 10) * 86_400_000).toISOString();
  s.exec(`INSERT INTO analytics_snapshots(platform, remote_id, published_at, views) VALUES ('youtube_shorts', ?, ?, ?)`, 'r' + i, pub, o.views as number);
}
const mk = () => { seq = 0; const cfg = testConfig(); return new Store(cfg.dbPath); };

test('unavailable metrics are excluded (not 0) and clips younger than 48h are not judged', () => {
  const s = mk(); add(s, { dur: 40, views: null }); add(s, { dur: 40, views: 100, pubAt: new Date(NOW - 5 * 3_600_000).toISOString() }); add(s, { dur: 40, views: 100 });
  const o = collectObservations(s, NOW); assert.equal(o.length, 1); assert.equal(o[0]!.views, 100);
});

test('small samples are NOT interpreted (insufficient_evidence)', () => {
  const o: Obs[] = Array.from({ length: 6 }, (_, i) => ({ uploadId: i, clipId: i, platform: 'p', channelId: 1, category: 'a', durationSec: 20, views: 1000 * (i + 1), publishedAt: 'x', ageHours: 100 }));
  const a = analyze(o); assert.equal(a.status, 'insufficient_evidence'); assert.deepEqual(a.insights, []);
});

test('insight states evidence + confidence and labels the cause a hypothesis', () => {
  const s = mk(); for (let i = 0; i < 10; i++) add(s, { dur: 20, views: 100 }); for (let i = 0; i < 10; i++) add(s, { dur: 40, views: 1000 }); // n=10 -> medium confidence (low-confidence insights never become proposals)
  const a = analyze(collectObservations(s, NOW)); assert.equal(a.status, 'ok');
  const st = a.insights.find((x) => x.dimension === 'duration' && x.bucket === '30-60')!; assert.equal(st.kind, 'strength'); assert.equal(st.n, 10); assert.ok(st.lift >= 1.5); assert.match(st.hypothesis, /HYPOTHESIS/);
});

test('propose -> apply -> revert: only the future clip-length setting changes, reversibly; editing config untouched', () => {
  const s = mk(); for (let i = 0; i < 10; i++) add(s, { dur: 20, views: 100 }); for (let i = 0; i < 10; i++) add(s, { dur: 40, views: 1000 }); // n=10 -> medium confidence (low-confidence insights never become proposals)
  const before = getChannel(s, mainChannel(s).id).config; const [c] = proposeChanges(s, NOW); assert.ok(c); assert.equal(c!.to, '30-60'); assert.equal(c!.status, 'proposed');
  assert.deepEqual(getChannel(s, c!.channelId).config, before, 'a proposal changes nothing');
  assert.equal(proposeChanges(s, NOW).length, 0, 'one open change per channel (attributable results)');
  const ap = applyChange(s, c!.id, NOW); assert.equal(ap.status, 'applied'); const after = getChannel(s, c!.channelId).config; assert.equal(after.clipLength, '30-60');
  assert.deepEqual({ ...after, clipLength: undefined }, { ...before, clipLength: undefined }, 'nothing else changed');
  assert.throws(() => applyChange(s, c!.id), /not proposed/);
  const rv = revertChange(s, c!.id, NOW); assert.equal(rv.status, 'reverted'); assert.equal(getChannel(s, c!.channelId).config.clipLength, before.clipLength);
  assert.equal(learningReport(s, NOW).changes.length, 1, 'history kept');
});

test('evaluate: no verdict before enough new evidence; then keep/revert recommendation (never acts)', () => {
  const s = mk(); for (let i = 0; i < 10; i++) add(s, { dur: 20, views: 100 }); for (let i = 0; i < 10; i++) add(s, { dur: 40, views: 1000 }); // n=10 -> medium confidence (low-confidence insights never become proposals)
  const [c] = proposeChanges(s, NOW); applyChange(s, c!.id, NOW - 5 * 86_400_000); // applied 5 days ago (baseline clips were published 10 days ago)
  assert.equal(evaluateChange(s, c!.id, NOW).verdict, undefined, 'clips published after apply: none yet');
  for (let i = 0; i < 5; i++) add(s, { dur: 40, views: 10, pubDaysAgo: 3 }); // clearly worse after the change
  const ev = evaluateChange(s, c!.id, NOW); assert.equal(ev.verdict?.keep, false); assert.equal(ev.status, 'applied', 'recommendation only, it does not revert by itself');
});
