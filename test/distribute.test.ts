import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { createChannel, ytSecretName } from '../src/channels.ts';
import { distribute } from '../src/publish/distribute.ts';
import { setDestinationEnabled } from '../src/accounts/destinations.ts';
import { join } from 'node:path';
import { tmpDir } from './helpers.ts';

test('many clips x many accounts: preview writes nothing; confirm creates one independent job per pair; duplicates, disabled and QC-failed are refused per pair', () => {
  const dataDir = tmpDir(); const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir }); const sec = new SecretStore(join(dataDir, 'secrets'), undefined);
  const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
  for (const [c, id] of [[a, 'UC_A'], [b, 'UC_B']] as const) { sec.write(ytSecretName(c), { refresh_token: 'R' + id }); store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, `ytinfo:${c.slug}`, JSON.stringify({ channelId: id, title: c.name, at: 'x' })); }
  store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f')`);
  for (const i of [1, 2, 3]) { store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,1,0,6,.5,?)`, i, 'c' + i); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,?,?)`, i, i, 'o' + i, '/x.mp4', i === 3 ? 0 : 1, JSON.stringify({ title: 'Clip ' + i })); }
  const req = { clipIds: [1, 2, 3], destinations: ['yt:UC_A', 'yt:UC_B'] };
  const pv = distribute(store, cfg, req); assert.equal(store.get<{ n: number }>('SELECT COUNT(*) n FROM uploads')!.n, 0, 'preview writes nothing');
  assert.equal(pv.items.filter((x) => x.status === 'new').length, 4); assert.equal(pv.items.filter((x) => x.status === 'blocked').length, 2); assert.ok(pv.items.find((x) => x.status === 'new')!.plannedAt, 'planned slot shown');
  const ok = distribute(store, cfg, { ...req, confirm: true }); assert.equal(ok.created, 4);
  const rows = store.all<{ clip_id: number; channel_id: number; destination_id: string }>('SELECT clip_id, channel_id, destination_id FROM uploads ORDER BY clip_id, channel_id'); assert.deepEqual(rows.map((r) => `${r.clip_id}:${r.channel_id}:${r.destination_id}`), [`1:${a.id}:yt:UC_A`, `1:${b.id}:yt:UC_B`, `2:${a.id}:yt:UC_A`, `2:${b.id}:yt:UC_B`]);
  assert.equal(distribute(store, cfg, { ...req, confirm: true }).created, 0, 'no duplicate routes'); assert.ok(distribute(store, cfg, req).items.filter((x) => x.clipId < 3).every((x) => x.status === 'duplicate'));
  setDestinationEnabled(store, 'yt:UC_B', false); assert.equal(distribute(store, cfg, { clipIds: [1], destinations: ['yt:UC_B'] }).items[0]!.reason, 'account disabled');
});
