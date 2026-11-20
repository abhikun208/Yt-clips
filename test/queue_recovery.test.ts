import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, enqueue, claim, extendLease, recoverOrphanJobs } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';

const mk = () => new Store(loadConfig(process.cwd(), { dataDir: tmpDir() }).dbPath);

test('regression: a long-running job keeps its lease (heartbeat) so it is never claimed twice', () => {
  const st = mk(); enqueue(st, 'render', 'render:1');
  const t0 = 1_000_000; const j = claim(st, 15 * 60_000, t0)!; assert.ok(j);
  assert.equal(claim(st, 15 * 60_000, t0 + 10 * 60_000), undefined, 'still leased at +10min');
  extendLease(st, j.id, 15 * 60_000, t0 + 14 * 60_000); // heartbeat at +14min
  assert.equal(claim(st, 15 * 60_000, t0 + 20 * 60_000), undefined, 'a 20-min job is NOT re-claimed while heartbeating');
  assert.ok(claim(st, 15 * 60_000, t0 + 40 * 60_000), 'a dead worker (no heartbeat) is reclaimed after the lease');
});

test('regression: after a restart, orphaned RUNNING jobs are re-queued immediately (not after the 15-min lease)', () => {
  const st = mk(); enqueue(st, 'analyze', 'analyze:5'); enqueue(st, 'render', 'render:9');
  claim(st, 15 * 60_000); assert.equal(claim(st, 15 * 60_000, Date.now() + 1) !== undefined, true); // both RUNNING now
  assert.equal(recoverOrphanJobs(st), 2);
  const again = claim(st); assert.ok(again, 'claimable right after the restart'); assert.equal(again!.attempts, 1, 'the crashed attempt is not counted against the retry budget');
});
