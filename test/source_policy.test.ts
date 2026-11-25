import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { advance, queueUpload, automationTick } from '../src/publish/service.ts';
import { distribute } from '../src/publish/distribute.ts';
import { createChannel, mainChannel } from '../src/channels.ts';
import { setSourceMapping } from '../src/accounts/destinations.ts';
import { getSourcePolicy, setSourcePolicy, sourceAllows } from '../src/accounts/sourcepolicy.ts';
import { tmpDir } from './helpers.ts';

function setup() {
  const dataDir = tmpDir(); const store = new Store(':memory:'); const main = mainChannel(store); const b = createChannel(store, { name: "Second" }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, authorized, channel_id) VALUES (1,'local','a',1,?)`, main.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f')`);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1','/x.mp4',1,?)`, JSON.stringify({ title: 'Clutch 1v4 #Shorts', description: 'd', tags: ['x'] }));
  return { dataDir, store, main, b };
}

test('policy rules: open / own_only / skipOwn / explicit distribute', () => {
  const { store, main, b } = setup();
  assert.equal(sourceAllows(store, 1, main.id, 'youtube_shorts').ok, true, 'own channel allowed by default');
  assert.equal(sourceAllows(store, 1, b.id, 'youtube_shorts').ok, false, 'unmapped channel is not permitted');
  assert.equal(sourceAllows(store, 1, b.id, 'youtube_shorts', true).ok, true, 'explicit owner Distribute is allowed in open mode');
  setSourceMapping(store, { sourceId: 1, channelId: b.id, platform: 'youtube_shorts' }); assert.equal(sourceAllows(store, 1, b.id, 'youtube_shorts').ok, true, 'mapped = permitted');
  assert.throws(() => setSourcePolicy(store, 1, { mode: 'bad' }), /invalid/);
  setSourcePolicy(store, 1, { skipOwn: true }); assert.equal(sourceAllows(store, 1, main.id, 'youtube_shorts').ok, false); assert.equal(sourceAllows(store, 1, b.id, 'youtube_shorts').ok, true);
  setSourcePolicy(store, 1, { mode: 'own_only' }); assert.deepEqual(getSourcePolicy(store, 1), { mode: 'own_only', skipOwn: false });
  assert.equal(sourceAllows(store, 1, main.id, 'youtube_shorts').ok, true); assert.equal(sourceAllows(store, 1, b.id, 'youtube_shorts', true).ok, false, 'exclusive: even an explicit Distribute is refused');
  assert.equal(sourceAllows(store, null, b.id, 'x').ok, true, 'no source = nothing to restrict');
});
test('skipOwn needs at least one mapped channel (clips must not vanish)', () => {
  const { store } = setup(); assert.throws(() => setSourcePolicy(store, 1, { skipOwn: true }), /mapped/);
});
test('own_only: the auto loop never queues to a mapped channel and advance() blocks a job that sneaked in; open mapping still queues', async () => {
  const { dataDir, store, b } = setup(); const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: true, platforms: ['youtube_shorts'], blockGenericMetadata: false, unlistedBufferMin: 0 }, gates: { publishEnabled: false } } });
  setSourceMapping(store, { sourceId: 1, channelId: b.id, platform: 'youtube_shorts' }); setSourcePolicy(store, 1, { mode: 'own_only' });
  await automationTick(store, cfg); assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM uploads WHERE channel_id=?`, b.id)!.n, 0, 'nothing queued for the mapped channel under own_only');
  const id = queueUpload(store, 1, 'youtube_shorts', b.id); const r = await advance(store, cfg, id); assert.equal((r as { blocked?: string }).blocked, 'SOURCE_POLICY');
  assert.match(store.get<{ error: string }>('SELECT error FROM uploads WHERE id=?', id)!.error, /exclusive/);
  const d = distribute(store, cfg, { clipIds: [1], destinations: [`yt:${b.slug}`] }); assert.ok(d.items.every((i) => i.status === 'blocked'), JSON.stringify(d.items));
  setSourcePolicy(store, 1, { mode: 'open' }); store.exec('DELETE FROM uploads'); await automationTick(store, cfg);
  assert.ok(store.get<{ n: number }>(`SELECT count(*) n FROM uploads WHERE channel_id=?`, b.id)!.n >= 1, 'open mode + mapping: queued for the second channel');
});
