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

test('a stuck (revoked) account at the head of the queue never starves the other account (round-robin, maxAdvancePerCycle=1)', async () => {
  const f = await startFake(); const old = { ...process.env }; f.opts.processedAfterPolls = 1;
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file); const store = new Store(':memory:'); const sec = new SecretStore(join(dataDir, 'secrets'), undefined);
    const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
    sec.write(ytSecretName(a), { refresh_token: 'REVOKED' }); sec.write(ytSecretName(b), { refresh_token: 'REFRESH-CH-B' });
    for (const [i, ch, title] of [[1, a, 'Stuck A one'], [2, a, 'Stuck A two'], [3, b, 'Healthy B one']] as const) {
      store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (?,?,?,?,1)`, i, 'local', 'r' + i, ch.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (?,?,?,?)`, i, i, '/x', 'f' + i);
      store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,?,0,6,.5,?)`, i, i, 'c' + i);
      store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,1,?)`, i, i, 'o' + i, file, JSON.stringify({ title: `${title} #Shorts`, description: 'd', tags: ['x'] }));
    }
    const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: true, maxAdvancePerCycle: 1, blockGenericMetadata: false, unlistedBufferMin: 0, fairShare: false }, gates: { publishEnabled: true } } });
    for (let i = 0; i < 12; i++) await automationTick(store, cfg);
    assert.equal(f.by['Healthy B one #Shorts'], 'REFRESH-CH-B', 'B uploaded although A\'s jobs are stuck ahead of it'); assert.equal(f.by['Stuck A one #Shorts'], undefined);
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});

test('upload is blocked when the channel login belongs to a DIFFERENT channel than the one registered (identity verified before every upload)', async () => {
  const f = await startFake(); const old = { ...process.env };
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file); const store = new Store(':memory:'); const sec = new SecretStore(join(dataDir, 'secrets'), undefined);
    const a = createChannel(store, { name: 'Chan A' }, () => true); sec.write(ytSecretName(a), { refresh_token: 'REFRESH-CH-A' });
    store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, `ytinfo:${a.slug}`, JSON.stringify({ channelId: 'UC_REGISTERED_ELSEWHERE', title: 'Other', at: 'x' }));
    store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f1')`);
    store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c1')`);
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Mismatch clip #Shorts', description: 'd', tags: ['x'] }));
    const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: true, maxAdvancePerCycle: 5, blockGenericMetadata: false, unlistedBufferMin: 0, fairShare: false }, gates: { publishEnabled: true } } });
    for (let i = 0; i < 4; i++) await automationTick(store, cfg);
    assert.equal(f.by['Mismatch clip #Shorts'], undefined, 'nothing was uploaded');
    const u = store.get<{ state: string; last_error: string | null }>('SELECT state, error AS last_error FROM uploads WHERE id=1'); assert.notEqual(u?.state, 'FAILED'); assert.match(u?.last_error ?? '', /AUTH_IDENTITY_MISMATCH/);
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
