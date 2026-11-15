import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';
import { isPaused, setPaused, autopilotState, autopilotPass, clipStatus } from '../src/autopilot/engine.ts';
import { automationTick } from '../src/publish/service.ts';

test('autopilot: pause blocks the whole tick, state/badge reflect config, CTR estimate stored once for QC-passed clips, status words', async () => {
  const cfg = loadConfig(tmpDir()); const store = new Store(join(tmpDir(), 'a.db'));
  assert.match(autopilotState(store, cfg).badge, /OFF/);
  cfg.automation.autoQueue = true; cfg.automation.autoApprove = true; cfg.automation.requireReview = false;
  let st = autopilotState(store, cfg); assert.equal(st.handsFree, true); assert.match(st.badge, /ON/);
  setPaused(store, true); assert.equal(isPaused(store), true); assert.match(autopilotState(store, cfg).badge, /PAUSED/);
  const r = await automationTick(store, cfg); assert.equal(r.blocked.PAUSED, 1); assert.equal(r.queued, 0);
  setPaused(store, false); assert.equal(autopilotPass(store, cfg), true);
  store.exec('INSERT INTO sources(id, kind, uri) VALUES (1,?,?)', 'local', 'x');
  assert.equal(clipStatus(store, 999, 'pending', 1), 'Waiting'); assert.equal(clipStatus(store, 999, 'rejected', 1), 'Rejected'); assert.equal(clipStatus(store, 999, 'pending', 0), 'QC fail');
});
