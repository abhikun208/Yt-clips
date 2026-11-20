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

test('regression: a clip whose output file vanished is NOT failed for good - a re-render is queued and the upload resumes once the file is back', async () => {
  const f = await startFake(); const old = { ...process.env }; f.opts.processedAfterPolls = 1;
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); const store = new Store(':memory:'); const sec = new SecretStore(join(dataDir, 'secrets'), undefined);
    const a = createChannel(store, { name: 'Chan A' }, () => true); sec.write(ytSecretName(a), { refresh_token: 'REFRESH-CH-A' });
    store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f1')`);
    store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c1')`);
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Vanished clip #Shorts', description: 'd', tags: ['x'] }));
    const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: true, maxAdvancePerCycle: 5, blockGenericMetadata: false, unlistedBufferMin: 0, fairShare: false }, gates: { publishEnabled: true } } });
    for (let i = 0; i < 6; i++) await automationTick(store, cfg);
    const u = store.get<{ state: string; error: string | null }>('SELECT state, error FROM uploads WHERE clip_id=1')!;
    assert.notEqual(u.state, 'FAILED'); assert.match(String(u.error), /NOT_READY: clip file missing/);
    assert.equal(store.get<{ state: string }>(`SELECT state FROM jobs WHERE key='render:1'`)?.state, 'PENDING', 're-render queued');
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=270x480:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]); // the render job "finished"
    for (let i = 0; i < 10; i++) await automationTick(store, cfg);
    assert.equal(f.by['Vanished clip #Shorts'], 'REFRESH-CH-A', 'uploaded after the file came back');
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
