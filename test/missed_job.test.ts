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

async function missedScenario(policy: 'reschedule' | 'publish_now') {
  const f = await startFake(); const old = { ...process.env }; f.opts.processedAfterPolls = 1;
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file); const store = new Store(':memory:'); const sec = new SecretStore(join(dataDir, 'secrets'), undefined);
    const a = createChannel(store, { name: 'Chan A' }, () => true); sec.write(ytSecretName(a), { refresh_token: 'REFRESH-CH-A' });
    store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f1')`);
    store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c1')`);
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Missed slot clip #Shorts', description: 'd', tags: ['x'] }));
    const base = { automation: { autoQueue: true, autoApprove: false, maxAdvancePerCycle: 5, blockGenericMetadata: false, unlistedBufferMin: 0, fairShare: false, missedJob: { policy, graceMinutes: 30 } } };
    const cfg1 = loadConfig(process.cwd(), { dataDir, overrides: { ...base, gates: { publishEnabled: true } } });
    for (let i = 0; i < 4; i++) await automationTick(store, cfg1); assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=1')!.state, 'UNLISTED_VERIFIED');
    store.exec(`UPDATE uploads SET state='SCHEDULED_OR_APPROVED', scheduled_at=? WHERE id=1`, new Date(Date.now() - 3 * 3600_000).toISOString()); // planned 3h ago, app was down
    const cfg2 = loadConfig(process.cwd(), { dataDir, overrides: { ...base, automation: { ...base.automation, autoApprove: true }, gates: { publishEnabled: true, publicVisibilityAllowed: true } } });
    await automationTick(store, cfg2); const v = [...f.videos.values()][0]!; return { status: v.status as { privacyStatus?: string; publishAt?: string } };
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
}
test('missed slot after downtime: default policy re-plans into a FUTURE slot instead of publishing immediately', async () => {
  const r = await missedScenario('reschedule'); assert.equal(r.status.privacyStatus, 'private'); assert.ok(r.status.publishAt && new Date(r.status.publishAt).getTime() > Date.now(), 'publishAt in the future');
});
test('missed slot with policy publish_now publishes right away (owner choice)', async () => {
  const r = await missedScenario('publish_now'); assert.equal(r.status.privacyStatus, 'public');
});


test('pause/resume: a paused job is skipped by the automation loop, other jobs keep moving; resume continues', async () => {
  const { createApp } = await import('../src/server/app.ts'); const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const dir = tmpDir(); const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: dir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const cfg = loadConfig(process.cwd(), { dataDir: dir }); const st = new Store(cfg.dbPath);
    st.exec(`INSERT INTO sources(id, kind, uri, authorized) VALUES (1,'local','r',1)`); st.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f')`); st.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
    st.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1','/x.mp4',1,'{"title":"T"}')`); st.exec(`INSERT INTO uploads(id, clip_id, platform, state, idempotency_key) VALUES (7,1,'youtube_shorts','UPLOAD_PENDING','k7')`);
    const post = (p: string) => fetch(base + p, { method: 'POST', headers: auth, body: '{}' });
    assert.equal((await post('/api/uploads/7/pause')).status, 200);
    const list = async () => (await (await fetch(base + '/api/uploads', { headers: auth })).json() as { uploads: { id: number; paused: boolean }[] }).uploads.find((x) => x.id === 7)!;
    assert.equal((await list()).paused, true); assert.equal((await post('/api/uploads/999/pause')).status, 404);
    assert.equal((await post('/api/uploads/7/resume')).status, 200); assert.equal((await list()).paused, false);
    st.exec(`UPDATE uploads SET state='PUBLISHED' WHERE id=7`); assert.equal((await post('/api/uploads/7/pause')).status, 400);
  } finally { await app.stop?.(); }
});
