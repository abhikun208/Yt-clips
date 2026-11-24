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
