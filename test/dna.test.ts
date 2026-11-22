import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelDna } from '../src/analytics/dna.ts';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';
import type { Obs } from '../src/analytics/learn.ts';

let id = 0; const mk = (category: string, views: number, channelId = 1): Obs => ({ uploadId: ++id, clipId: id, platform: 'youtube', channelId, category, durationSec: 30, views, publishedAt: '2026-01-01', ageHours: 200 });
const many = (cat: string, n: number, v: number, ch = 1) => Array.from({ length: n }, (_, i) => mk(cat, v + i, ch));

test('too few clips => NO EVIDENCE YET with the real count', () => {
  const d = channelDna(many('gaming', 5, 100)); assert.equal(d.recommendation, 'NO EVIDENCE YET'); assert.equal(d.observations, 5); assert.match(d.reason, /have 5/);
});
test('one category clearly stronger (not already dominant) => FOCUS with n and lift', () => {
  const d = channelDna([...many('gaming', 6, 1000), ...many('vlog', 8, 100), ...many('comedy', 8, 120)]); assert.equal(d.recommendation, 'FOCUS'); assert.equal(d.focus, 'gaming'); assert.ok(d.categories.find((c) => c.category === 'gaming')!.lift >= 1.5); assert.equal(d.label, 'HEURISTIC');
});
test('similar performance => KEEP_MIXED; strong + weak across 3 categories => SPLIT_CHANNELS', () => {
  assert.equal(channelDna([...many('gaming', 6, 100), ...many('vlog', 6, 105), ...many('comedy', 6, 98)]).recommendation, 'KEEP_MIXED');
  assert.equal(channelDna([...many('gaming', 6, 1000), ...many('vlog', 6, 100), ...many('comedy', 6, 400)]).recommendation, 'SPLIT_CHANNELS');
});
test('only one comparable category => NO EVIDENCE YET; channel filter applies', () => {
  assert.equal(channelDna([...many('gaming', 12, 100), ...many('vlog', 2, 900)]).recommendation, 'NO EVIDENCE YET');
  assert.equal(channelDna([...many('gaming', 20, 100, 1), ...many('vlog', 3, 5, 2)], 2).observations, 3);
});
test('API (real HTTP): empty database answers NO EVIDENCE YET', async () => {
  const T = 'test-token-0123456789'; const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try { const d = await (await fetch(base + '/api/analytics/dna', { headers: { authorization: `Bearer ${T}` } })).json() as { recommendation: string }; assert.equal(d.recommendation, 'NO EVIDENCE YET'); } finally { await app.stop(); }
});
