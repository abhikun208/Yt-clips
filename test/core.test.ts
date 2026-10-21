import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, enqueue, claim, completeJob, failJob } from '../src/db.ts';
import { assertPublishAllowed, loadConfig } from '../src/config.ts';
import { redact } from '../src/util/log.ts';
import { tmpDir } from './helpers.ts';

test('db migrations are idempotent and never drop data', () => {
  const dir = tmpDir(); const p = `${dir}/a.sqlite`;
  const s1 = new Store(p); s1.exec(`INSERT INTO sources(kind, uri) VALUES ('local','x')`); s1.close();
  const s2 = new Store(p); // re-open runs migrate again
  assert.equal(s2.get<{ n: number }>('SELECT count(*) n FROM sources')!.n, 1);
  s2.close();
});

test('job queue: dedupe key, lease, retry with backoff, DEAD after max attempts', () => {
  const s = new Store(':memory:');
  assert.equal(enqueue(s, 'analyze', 'k1'), true);
  assert.equal(enqueue(s, 'analyze', 'k1'), false, 'duplicate key must not enqueue twice');
  const now = 1_000_000;
  let j = claim(s, 1000, now)!; assert.equal(j.attempts, 1);
  assert.equal(claim(s, 1000, now), undefined, 'leased job not claimable');
  assert.equal(failJob(s, j, 'x', 3, now, () => 0.5), 'RETRY');
  assert.equal(claim(s, 1000, now + 1), undefined, 'backoff not elapsed');
  j = claim(s, 1000, now + 60_000)!; assert.equal(j.attempts, 2);
  failJob(s, j, 'x', 3, now + 60_000, () => 0.5);
  j = claim(s, 1000, now + 10 * 60_000)!; assert.equal(j.attempts, 3);
  assert.equal(failJob(s, j, 'x', 3, now, () => 0.5), 'DEAD');
  assert.equal(claim(s, 1000, now + 99 * 60_000), undefined, 'DEAD never re-claimed');
  assert.equal(s.get<{ n: number }>("SELECT count(*) n FROM jobs WHERE state='DEAD'")!.n, 1, 'DEAD job retained for inspection');
});

test('expired lease is reclaimed after crash', () => {
  const s = new Store(':memory:'); enqueue(s, 'k', 'a');
  const j = claim(s, 100, 0)!; assert.ok(j);
  assert.ok(claim(s, 100, 500), 'lease expired -> claimable again');
});

test('safety gates default OFF and block publish', () => {
  const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() });
  assert.equal(cfg.gates.publishEnabled, false); assert.equal(cfg.gates.commentsAutoPost, false); assert.equal(cfg.gates.publicVisibilityAllowed, false);
  assert.throws(() => assertPublishAllowed(cfg, 'unlisted'), /PUBLISH_DISABLED/);
  const on = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { gates: { publishEnabled: true } } });
  assert.doesNotThrow(() => assertPublishAllowed(on, 'unlisted'));
  assert.throws(() => assertPublishAllowed(on, 'public'), /PUBLIC_DISABLED/);
});

test('logger redacts secrets', () => {
  const r = redact({ access_token: 'ya29.abcdef', note: 'Bearer abc.def-123', nested: { apiKey: 'sk-1234567890abcdefgh' } }) as any;
  assert.equal(r.access_token, '[REDACTED]'); assert.ok(!JSON.stringify(r).includes('abc.def-123')); assert.equal(r.nested.apiKey, '[REDACTED]');
});
