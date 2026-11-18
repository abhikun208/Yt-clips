import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig, updateOwnerConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { automationTick } from '../src/publish/service.ts';
import { parseAutopilotOn, parseDelay, effectiveSummary } from '../src/autopilot/flags.ts';
import { autopilotState } from '../src/autopilot/engine.ts';
import { run } from '../src/util/proc.ts';
import { startFake } from './fakeGoogle.ts';
import { tmpDir } from './helpers.ts';

test('delay syntax: 10-30m, 15m, 1-2h, bare minutes; garbage rejected', () => {
  assert.deepEqual(parseDelay('10-30m'), { minMin: 10, maxMin: 30 }); assert.deepEqual(parseDelay('15m'), { minMin: 15, maxMin: 15 }); assert.deepEqual(parseDelay('1-2h'), { minMin: 60, maxMin: 120 }); assert.deepEqual(parseDelay('20'), { minMin: 20, maxMin: 20 });
  for (const bad of ['', 'abc', '30-10m', '0m', '100h', '10-30x', '-5m']) assert.throws(() => parseDelay(bad), /invalid --public-delay/, bad);
});
test('the owner\'s exact command is fully understood; unsupported/contradicting flags are never silently ignored', () => {
  const p = parseAutopilotOn(['--unlisted', '--yes', '--auto-approve', '--auto-public', '--public-delay', '10-30m']);
  const a = p.patch.automation as Record<string, unknown>; const g = p.patch.gates as Record<string, boolean>;
  assert.equal(a.autoApprove, true); assert.equal(a.requireReview, false); assert.equal(a.unlistedFirst, true); assert.deepEqual(a.autoPublic, { enabled: true, minMin: 10, maxMin: 30 }); assert.equal(g.publishEnabled, true); assert.equal(g.publicVisibilityAllowed, true);
  assert.deepEqual((parseAutopilotOn(['--yes', '--auto-approve', '--auto-public', '--public-delay=1-2h']).patch.automation as { autoPublic: unknown }).autoPublic, { enabled: true, minMin: 60, maxMin: 120 });
  assert.throws(() => parseAutopilotOn(['--bogus']), /unknown or unsupported flag/); assert.throws(() => parseAutopilotOn(['--auto-public', '--auto-approve']), /--yes/);
  assert.throws(() => parseAutopilotOn(['--yes', '--public-delay', '10m']), /only makes sense together with --auto-public/); assert.throws(() => parseAutopilotOn(['--yes', '--auto-public']), /needs --auto-approve/);
  assert.throws(() => parseAutopilotOn(['--yes', '--auto-approve', '--auto-public', '--public-delay']), /needs a value/); assert.throws(() => parseAutopilotOn(['--yes', '--review', '--auto-approve']), /contradict/);
});
test('settings persist to data/config.json (0600) and come back as effective settings; off closes them', () => {
  const dataDir = tmpDir(); const cfg0 = loadConfig(process.cwd(), { dataDir });
  updateOwnerConfig(cfg0, parseAutopilotOn(['--unlisted', '--yes', '--auto-approve', '--auto-public', '--public-delay', '10-30m']).patch);
  const cfg = loadConfig(process.cwd(), { dataDir }); assert.equal(cfg.automation.autoApprove, true); assert.equal(cfg.automation.requireReview, false); assert.deepEqual(cfg.automation.autoPublic, { enabled: true, minMin: 10, maxMin: 30 }); assert.equal(cfg.gates.publicVisibilityAllowed, true);
  assert.match(effectiveSummary(cfg.automation, cfg.gates), /auto-public after 10-30m/); const st = autopilotState(new Store(':memory:'), cfg); assert.match(st.effective, /auto-public after 10-30m/); assert.equal(st.handsFree, true);
  updateOwnerConfig(cfg, { automation: { autoQueue: false, autoApprove: false, autoPublic: { enabled: false } }, gates: { publishEnabled: false, publicVisibilityAllowed: false } });
  const off = loadConfig(process.cwd(), { dataDir }); assert.equal(off.automation.autoPublic?.enabled, false); assert.equal(off.gates.publishEnabled, false);
});

async function vertical(out: string) { const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=270x480:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); assert.equal(r.code, 0, r.stderr); }
function seed(store: Store, file: string) {
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Hello #Shorts', description: 'd', tags: ['x'] }));
}
test('end-to-end (fake YouTube): unlisted first → persisted random delay survives restart → public after delay → visibility verified via API → never published twice', async () => {
  const f = await startFake(); const old = { ...process.env }; f.opts.processedAfterPolls = 1;
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file); const dbPath = join(tmpDir(), 'a.db');
    new SecretStore(join(dataDir, 'secrets'), undefined).write('youtube', { refresh_token: 'REFRESH-TOKEN-XYZ' });
    let store = new Store(dbPath); seed(store, file);
    const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: true, autoApprove: true, requireReview: false, autoPublic: { enabled: true, minMin: 10, maxMin: 30 }, blockGenericMetadata: false, unlistedBufferMin: 0 }, gates: { publishEnabled: true, publicVisibilityAllowed: true } } });
    const t0 = new Date('2030-01-01T00:00:00Z'); const state = () => store.get<{ state: string }>('SELECT state FROM uploads WHERE id=1')!.state;
    await automationTick(store, cfg, t0); await automationTick(store, cfg, t0); const r3 = await automationTick(store, cfg, t0);
    assert.equal(state(), 'UNLISTED_VERIFIED', JSON.stringify(r3)); assert.equal(f.videos.get('vid_sess1').status.privacyStatus, 'unlisted', 'uploaded UNLISTED first');
    const pubAt = new Date(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='pubat:1'`)!.v); const dm = (pubAt.getTime() - t0.getTime()) / 60_000; assert.ok(dm >= 10 && dm <= 30, `delay ${dm}m inside 10-30m`);
    assert.ok((r3.blocked.WAIT_PUBLIC_DELAY ?? 0) >= 1); assert.equal(r3.published, 0);
    // restart: new Store on the same DB file, same persisted time, still unlisted before the delay
    store = new Store(dbPath); const early = await automationTick(store, cfg, new Date(t0.getTime() + 5 * 60_000));
    assert.equal(early.published, 0); assert.equal(state(), 'UNLISTED_VERIFIED'); assert.equal(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='pubat:1'`)!.v, pubAt.toISOString(), 'delay not re-rolled after restart'); assert.equal(f.videos.get('vid_sess1').status.privacyStatus, 'unlisted');
    const late = await automationTick(store, cfg, new Date(t0.getTime() + 31 * 60_000)); assert.equal(late.published, 1, JSON.stringify(late));
    assert.equal(f.videos.get('vid_sess1').status.privacyStatus, 'public', 'YouTube itself reports public'); assert.equal(state(), 'PUBLISHED');
    const again = await automationTick(store, cfg, new Date(t0.getTime() + 60 * 60_000)); assert.equal(again.published, 0); assert.equal(again.queued, 0, 'no duplicate publishing');
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
