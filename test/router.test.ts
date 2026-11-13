import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRound, fairPick } from '../src/publish/router.ts';
import { Store } from '../src/db.ts';
import { tmpDir } from './helpers.ts';
import { join } from 'node:path';

const mk = (src: number, ids: number[]) => ids.map((id) => ({ clipId: id, sourceId: src, lastAttemptAt: null as string | null }));

test('pickRound: A(5) B(3) C(1) -> exactly one clip per source per round; round restarts only after all served', () => {
  const all = [...mk(1, [1, 2, 3, 4, 5]), ...mk(2, [6, 7, 8]), ...mk(3, [9])];
  const r1 = pickRound(all, []); assert.deepEqual(r1.picks.map((p) => p.clipId), [1, 6, 9]); assert.equal(r1.newRound, false);
  const left = all.filter((c) => !r1.picks.some((p) => p.clipId === c.clipId)); // 1,6,9 are queued now
  const r2 = pickRound(left, r1.served); assert.deepEqual(r2.picks.map((p) => p.clipId), [2, 7]); assert.equal(r2.newRound, true); // C has nothing left: skipped
  const left2 = left.filter((c) => !r2.picks.some((p) => p.clipId === c.clipId)); const r3 = pickRound(left2, r2.served); assert.deepEqual(r3.picks.map((p) => p.clipId), [3, 8]);
  const r4 = pickRound(left2.filter((c) => !r3.picks.some((p) => p.clipId === c.clipId)), r3.served); assert.deepEqual(r4.picks.map((p) => p.clipId), [4]);
});

test('pickRound: a source that got its clip this round waits; a source that gets a new clip mid-round is served next', () => {
  const r1 = pickRound([...mk(1, [1, 2]), ...mk(2, [3])], []); assert.deepEqual(r1.picks.map((p) => p.sourceId), [1, 2]);
  const r2 = pickRound([...mk(1, [2]), ...mk(3, [10])], r1.served); assert.deepEqual(r2.picks.map((p) => p.clipId), [10]); // 1 already served this round, 3 is new
});

test('pickRound: recently attempted clips are not retried before retryHours', () => {
  const now = Date.parse('2026-11-14T10:00:00Z'); const c = [{ clipId: 1, sourceId: 1, lastAttemptAt: '2026-11-14 08:00:00' }, { clipId: 2, sourceId: 1, lastAttemptAt: '2026-11-14 01:00:00' }];
  assert.deepEqual(pickRound(c, [], { retryHours: 6, now }).picks.map((p) => p.clipId), [2]); assert.deepEqual(pickRound(c, [], { retryHours: 12, now }).picks, []);
});

test('fairPick (DB): two scheduler runs pick 3 then the next set, no duplicates, last_attempt_at stamped, per-source queue cap', () => {
  const s = new Store(join(tmpDir(), 't.db')); for (const [i, n] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) s.exec('INSERT INTO sources(id, kind, uri) VALUES (?,?,?)', i, 'local', n);
  const rows = [...mk(1, [1, 2, 3, 4, 5]), ...mk(2, [6, 7, 8]), ...mk(3, [9])];
  for (const i of [1, 2, 3]) s.exec('INSERT INTO videos(id, source_id, path, fingerprint) VALUES (?,?,?,?)', i, i, `/v${i}`, `f${i}`);
  for (const r of rows) { s.exec('INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,?,?,?,?,?)', r.clipId, r.sourceId, 0, 10, 0.5, `c${r.clipId}`); s.exec('INSERT INTO clips(id, candidate_id, output_id) VALUES (?,?,?)', r.clipId, r.clipId, `o${r.clipId}`); }
  const p1 = fairPick(s, 1, 'youtube_shorts', rows); assert.deepEqual(p1, [1, 6, 9]);
  assert.ok(s.get<{ t: string | null }>('SELECT last_attempt_at t FROM clips WHERE id=1')!.t);
  const rest = rows.filter((r) => !p1.includes(r.clipId)); const p2 = fairPick(s, 1, 'youtube_shorts', rest); assert.deepEqual(p2, [2, 7]); assert.equal(p2.filter((x) => p1.includes(x)).length, 0);
});

test('fairPick: a source that already has its max queued uploads is skipped while others wait; a lone source is never throttled', () => {
  const s = new Store(join(tmpDir(), 't2.db')); for (const i of [1, 2]) { s.exec('INSERT INTO sources(id, kind, uri) VALUES (?,?,?)', i, 'local', `u${i}`); s.exec('INSERT INTO videos(id, source_id, path, fingerprint) VALUES (?,?,?,?)', i, i, `/v${i}`, `f${i}`); }
  for (const id of [1, 2, 3, 4]) { const src = id <= 3 ? 1 : 2; s.exec('INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,?,?,?,?,?)', id, src, 0, 10, 0.5, `c${id}`); s.exec('INSERT INTO clips(id, candidate_id, output_id) VALUES (?,?,?)', id, id, `o${id}`); }
  s.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key) VALUES (1,'p','QC_PASSED','k1'),(2,'p','QC_PASSED','k2')`); // source 1 already has 2 queued
  assert.deepEqual(fairPick(s, 1, 'p', [...mk(1, [3]), ...mk(2, [4])]), [4]);
  assert.deepEqual(fairPick(s, 2, 'p', mk(1, [3])), [3]); // only one source left: not throttled
});

test('integration: automationTick with 2 sources mapped to 2 accounts - fair share queues one per source on the RIGHT account; fairShare:false keeps the old order', async () => {
  const { automationTick } = await import('../src/publish/service.ts'); const { createChannel, mainChannel } = await import('../src/channels.ts'); const { testConfig } = await import('./helpers.ts');
  const run = async (fair: boolean) => {
    const cfg = testConfig({ automation: { autoQueue: true, platforms: ['youtube_shorts'], autoApprove: false, maxAdvancePerCycle: 20, requireReview: false, titleTest: false, titleTestHours: 24, funnelComment: false, fairShare: fair } } as never);
    const s = new Store(cfg.dbPath); const main = mainChannel(s); const other = createChannel(s, { name: 'Second' }, () => true);
    s.exec('INSERT INTO sources(id, kind, uri, channel_id) VALUES (1,?,?,?),(2,?,?,?)', 'local', 'a', main.id, 'local', 'b', other.id);
    for (const [i, src] of [1, 2].entries()) s.exec('INSERT INTO videos(id, source_id, path, fingerprint) VALUES (?,?,?,?)', i + 1, src, `/v${src}`, `f${src}`);
    const ids: number[] = []; for (const [n, src] of [[1, 1], [2, 1], [3, 1], [4, 2], [5, 2]] as const) { ids.push(n); s.exec('INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,?,?,?,?,?)', n, src, 0, 10, 0.6, `c${n}`); s.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,1,'{"title":"t","generic":0}')`, n, n, `o${n}`, `/e${n}.mp4`); }
    const t = await automationTick(s, cfg); const ups = s.all<{ clip_id: number; channel_id: number }>('SELECT clip_id, channel_id FROM uploads ORDER BY id'); return { t, ups, main: main.id, other: other.id };
  };
  const f = await run(true); assert.equal(f.t.queued, 2); assert.deepEqual(f.ups.map((u) => [u.clip_id, u.channel_id]), [[1, f.main], [4, f.other]]);
  const old = await run(false); assert.equal(old.t.queued, 5);
});
