import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerEnvPatch, loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';

test('ownerEnvPatch: DRY_RUN/unset changes nothing; PUBLIC opens gates + autoQueue; PRIVATE never opens public; AUTO_APPROVE parses', () => {
  assert.deepEqual(ownerEnvPatch({}), {}); assert.deepEqual(ownerEnvPatch({ PUBLISH_MODE: 'DRY_RUN' }), {}); assert.deepEqual(ownerEnvPatch({ PUBLISH_MODE: 'garbage' }), {});
  assert.deepEqual(ownerEnvPatch({ PUBLISH_MODE: 'public' }), { gates: { publishEnabled: true, publicVisibilityAllowed: true }, automation: { autoQueue: true } });
  assert.deepEqual(ownerEnvPatch({ PUBLISH_MODE: 'PRIVATE' }), { gates: { publishEnabled: true }, automation: { autoQueue: true } });
  assert.deepEqual(ownerEnvPatch({ AUTO_APPROVE: 'true' }), { automation: { autoApprove: true } }); assert.deepEqual(ownerEnvPatch({ AUTO_APPROVE: 'off' }), { automation: { autoApprove: false } });
  assert.deepEqual(ownerEnvPatch({ PUBLISH_MODE: 'PUBLIC', YT_CLIPS_OWNER_ENV: '0' }), {});
});
test('loadConfig: .env values win over data/config.json, test overrides win over both, unset env leaves gates closed', () => {
  const old = { ...process.env }; try {
    process.env.YT_CLIPS_OWNER_ENV = '1'; delete process.env.PUBLISH_MODE; delete process.env.AUTO_APPROVE;
    const d = tmpDir(); const closed = loadConfig(process.cwd(), { dataDir: d }); assert.equal(closed.gates.publishEnabled, false); assert.equal(closed.automation.autoApprove, false);
    process.env.PUBLISH_MODE = 'PUBLIC'; process.env.AUTO_APPROVE = 'true'; const open = loadConfig(process.cwd(), { dataDir: d });
    assert.deepEqual([open.gates.publishEnabled, open.gates.publicVisibilityAllowed, open.automation.autoQueue, open.automation.autoApprove], [true, true, true, true]);
    assert.equal(loadConfig(process.cwd(), { dataDir: d, overrides: { gates: { publishEnabled: false } } }).gates.publishEnabled, false);
  } finally { process.env = old; }
});
