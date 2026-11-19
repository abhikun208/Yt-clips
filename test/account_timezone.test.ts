import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { createChannel, updateChannel, scheduleFor, getChannel } from '../src/channels.ts';
import { loadConfig } from '../src/config.ts';
import { planFromStore } from '../src/schedule/analytics.ts';
import { tmpDir } from './helpers.ts';

test('each account has its own timezone: validated, stored, and the same baseline hour lands at different UTC instants', () => {
  const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() });
  const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
  assert.throws(() => updateChannel(store, a.id, { config: { schedule: { timezone: 'Mars/Phobos' } } }, () => true), /timezone/);
  updateChannel(store, a.id, { config: { schedule: { timezone: 'Asia/Kolkata', baselineHours: [13], quietHours: [0, 0], jitterMinutes: 0, perDayCap: 1 } } }, () => true);
  updateChannel(store, b.id, { config: { schedule: { timezone: 'America/New_York', baselineHours: [13], quietHours: [0, 0], jitterMinutes: 0, perDayCap: 1 } } }, () => true);
  const from = new Date('2026-11-19T00:00:00Z'); const sa = scheduleFor(cfg, getChannel(store, a.id)); const sb = scheduleFor(cfg, getChannel(store, b.id));
  assert.equal(sa.timezone, 'Asia/Kolkata'); assert.equal(sb.timezone, 'America/New_York');
  const pa = planFromStore(store, { n: 1, tz: sa.timezone!, cfg: sa, from }).slots[0]!; const pb = planFromStore(store, { n: 1, tz: sb.timezone!, cfg: sb, from }).slots[0]!;
  assert.equal(pa.at.toISOString(), '2026-11-19T07:30:00.000Z', '13:00 IST = 07:30 UTC'); assert.equal(pb.at.toISOString(), '2026-11-19T18:00:00.000Z', '13:00 EST = 18:00 UTC');
});
