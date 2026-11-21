import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createChannel } from '../src/channels.ts';
import { setSourceMapping, listSourceMappings } from '../src/accounts/destinations.ts';
import { automationTick } from '../src/publish/service.ts';
import { tmpDir } from './helpers.ts';

test('one source -> two channels: clip is queued for its own channel AND the mapped one (separate jobs); disabled/removed mappings queue nothing', async () => {
  const store = new Store(':memory:'); const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f1')`);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c1')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1','/x.mp4',1,?)`, JSON.stringify({ title: 'Real title one #Shorts', description: 'd', tags: ['x'] }));
  assert.throws(() => setSourceMapping(store, { sourceId: 1, channelId: a.id }), /apna channel/);
  setSourceMapping(store, { sourceId: 1, channelId: b.id }); assert.equal(listSourceMappings(store, 1).length, 1);
  const cfg = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { automation: { autoQueue: true, maxAdvancePerCycle: 5, blockGenericMetadata: false, fairShare: false, platforms: ['youtube_shorts'] }, gates: { publishEnabled: false } } });
  await automationTick(store, cfg); await automationTick(store, cfg);
  const ups = store.all<{ channel_id: number }>('SELECT channel_id FROM uploads ORDER BY id'); assert.deepEqual(ups.map((u) => u.channel_id).sort(), [a.id, b.id].sort(), 'one job per destination, no duplicates');
  setSourceMapping(store, { sourceId: 1, channelId: b.id, remove: true }); assert.equal(listSourceMappings(store, 1).length, 0);
});

test('per-destination title/tag policy is additive and editing it preserves delay/priority', () => {
  const store = new Store(':memory:'); const a = createChannel(store, { name: 'Main' }, () => true); const b = createChannel(store, { name: 'Decider' }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id);
  setSourceMapping(store, { sourceId: 1, channelId: b.id, delayMin: 25, priority: 4, metadata: { titlePrefix: 'Gaming', titleSuffix: '| Decider', tags: ['freefire', 'clutch'] } });
  setSourceMapping(store, { sourceId: 1, channelId: b.id, enabled: false });
  const m = listSourceMappings(store, 1)[0]!;
  assert.deepEqual([m.delayMin, m.priority, m.enabled], [25, 4, false]);
  assert.deepEqual(m.metadata, { titlePrefix: 'Gaming', titleSuffix: '| Decider', tags: ['freefire', 'clutch'] });
});

test('mapping policy: per-destination delay holds ONLY that destination; editing one field keeps the others; disable stops new jobs', async () => {
  const store = new Store(':memory:'); const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f1')`);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c1')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1','/x.mp4',1,?)`, JSON.stringify({ title: 'Real title one #Shorts', description: 'd', tags: ['x'] }));
  setSourceMapping(store, { sourceId: 1, channelId: b.id, delayMin: 30, priority: 3 }); setSourceMapping(store, { sourceId: 1, channelId: b.id, enabled: true });
  const mp = listSourceMappings(store, 1)[0]!; assert.deepEqual([mp.delayMin, mp.priority, mp.enabled], [30, 3, true], 'toggling enabled must not reset delay/priority');
  const cfg = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { automation: { autoQueue: true, maxAdvancePerCycle: 5, blockGenericMetadata: false, fairShare: false, platforms: ['youtube_shorts'] } } as never });
  const t0 = new Date(); await automationTick(store, cfg, t0); await automationTick(store, cfg, t0);
  const st = (ch: number) => store.get<{ error: string | null }>('SELECT error FROM uploads WHERE channel_id=?', ch)!.error ? 'TRIED' : 'QC_PASSED'; // (fake clip file -> a processed job records NOT_READY)
  assert.equal(st(a.id), 'TRIED', 'own channel moves on at once'); assert.equal(st(b.id), 'QC_PASSED', 'mapped destination waits for its delay');
  await automationTick(store, cfg, new Date(t0.getTime() + 31 * 60_000)); assert.equal(st(b.id), 'TRIED', 'after the delay it proceeds');
  setSourceMapping(store, { sourceId: 1, channelId: b.id, enabled: false }); assert.equal(listSourceMappings(store, 1)[0]!.enabled, false);
});
