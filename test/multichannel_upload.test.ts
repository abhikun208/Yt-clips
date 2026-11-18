import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { automationTick } from '../src/publish/service.ts';
import { createChannel, ytSecretName } from '../src/channels.ts';
import { run } from '../src/util/proc.ts';
import { startFake } from './fakeGoogle.ts';
import { tmpDir } from './helpers.ts';

async function vertical(out: string) { const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=270x480:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]); assert.equal(r.code, 0, r.stderr); }

test('two YouTube channels: each source\'s clip uploads with ITS OWN channel token (never the other\'s); a revoked channel does not block the other', async () => {
  const f = await startFake(); const old = { ...process.env }; f.opts.processedAfterPolls = 1;
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file); const store = new Store(':memory:'); const sec = new SecretStore(join(dataDir, 'secrets'), undefined);
    const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
    sec.write(ytSecretName(a), { refresh_token: 'REFRESH-CH-A' }); sec.write(ytSecretName(b), { refresh_token: 'REFRESH-CH-B' });
    for (const [i, ch, title] of [[1, a, 'Title for A'], [2, b, 'Title for B']] as const) {
      store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (?,?,?,?,1)`, i, 'local', 'r' + i, ch.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (?,?,?,?)`, i, i, '/x', 'f' + i);
      store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,?,0,6,.5,?)`, i, i, 'c' + i);
      store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,1,?)`, i, i, 'o' + i, file, JSON.stringify({ title: `${title} #Shorts`, description: 'd', tags: ['x'] }));
    }
    const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: true, maxAdvancePerCycle: 5, blockGenericMetadata: false, unlistedBufferMin: 0, fairShare: false }, gates: { publishEnabled: true } } });
    for (let i = 0; i < 4; i++) await automationTick(store, cfg);
    assert.equal(f.by['Title for A #Shorts'], 'REFRESH-CH-A', 'A uploaded with A token'); assert.equal(f.by['Title for B #Shorts'], 'REFRESH-CH-B', 'B uploaded with B token');
    const st = store.all<{ id: number; state: string; channel_id: number }>('SELECT id, state, channel_id FROM uploads ORDER BY id'); assert.equal(st.length, 2); assert.deepEqual(st.map((x) => x.channel_id).sort(), [a.id, b.id].sort());
    assert.ok(st.every((x) => x.state === 'UNLISTED_VERIFIED'), JSON.stringify(st));
    // isolation: revoke A (its token no longer works); B's next clip must still upload
    sec.write(ytSecretName(a), { refresh_token: 'REVOKED' });
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (3,1,'o3',?,1,?)`, file, JSON.stringify({ title: 'A again #Shorts', description: 'd', tags: ['x'] }));
    store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (4,2,0,6,.5,'c4')`); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (4,4,'o4',?,1,?)`, file, JSON.stringify({ title: 'B again #Shorts', description: 'd', tags: ['x'] }));
    for (let i = 0; i < 4; i++) await automationTick(store, cfg);
    assert.equal(f.by['B again #Shorts'], 'REFRESH-CH-B', 'B still uploads while A is revoked'); assert.equal(f.by['A again #Shorts'], undefined, 'A (revoked) did not upload and did not borrow B\'s token');
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
