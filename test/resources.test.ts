import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, sampleResources } from '../src/util/resources.ts';

const ok = { memFreeMB: 2000, memTotalMB: 4000, load1: 0.5, cpus: 8, rssMB: 100, diskFreeMB: 20000 };
test('assess: ok / warn / critical decisions and lane limits', () => {
  assert.deepEqual(assess(ok), { level: 'ok', allowHeavy: true, maxLanes: 6, reasons: [] });
  const w = assess({ ...ok, memFreeMB: 300 }); assert.equal(w.level, 'warn'); assert.equal(w.allowHeavy, true); assert.equal(w.maxLanes, 1);
  const c = assess({ ...ok, diskFreeMB: 100 }); assert.equal(c.level, 'critical'); assert.equal(c.allowHeavy, false); assert.match(c.reasons.join(), /disk/);
  assert.equal(assess({ ...ok, load1: 30 }).maxLanes, 1); assert.equal(assess({ ...ok, diskFreeMB: null }).level, 'ok', 'unknown disk is not guessed');
});
test('sampleResources reads real values on this machine', () => {
  const s = sampleResources('.'); assert.ok(s.memTotalMB > 100 && s.rssMB > 5 && s.cpus >= 1); assert.ok(s.memFreeMB >= 0);
});

test('overload: > 4 load per core pauses new heavy work (CPU reason only), 3.75 per core still runs with 1 lane', async () => {
  const { assess } = await import('../src/util/resources.ts');
  const a = assess({ memFreeMB: 2000, memTotalMB: 4000, load1: 20, cpus: 4, rssMB: 100, diskFreeMB: 20000 }); assert.equal(a.allowHeavy, false); assert.match(a.reasons.join(), /CPU overloaded/);
  const b = assess({ memFreeMB: 2000, memTotalMB: 4000, load1: 15, cpus: 4, rssMB: 100, diskFreeMB: 20000 }); assert.equal(b.allowHeavy, true); assert.equal(b.maxLanes, 1);
});
test('lite mode: Android/<=3GB/forced on, forced off, normal PC stays normal', async () => {
  const { liteMode } = await import('../src/config.ts');
  assert.equal(liteMode({}, 8000, false), false); assert.equal(liteMode({}, 2500, false), true); assert.equal(liteMode({}, 8000, true), true); assert.equal(liteMode({ YT_CLIPS_LITE: '1' }, 8000, false), true); assert.equal(liteMode({ YT_CLIPS_LITE: '0' }, 2000, true), false);
});
