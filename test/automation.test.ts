import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { automationTick } from '../src/publish/service.ts';
import { run } from '../src/util/proc.ts';
import { startFake } from './fakeGoogle.ts';
import { tmpDir } from './helpers.ts';

async function vertical(out: string) {
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=270x480:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { timeoutMs: 60000 }); if (r.code !== 0) throw new Error(r.stderr);
}
function seed(store: Store, file: string) {
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Hello #Shorts', description: 'd', tags: ['x'] }));
}

test('automation loop: OFF by default and gates-off => zero platform traffic; owner-enabled => queue -> unlisted verified -> (autoApprove) scheduled -> published, real probe of a real clip', async () => {
  const f = await startFake(); const old = { ...process.env }; f.opts.processedAfterPolls = 1;
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file);
    new SecretStore(join(dataDir, 'secrets'), undefined).write('youtube', { refresh_token: 'REFRESH-TOKEN-XYZ' });
    const store = new Store(':memory:'); seed(store, file);
    const mk = (o: Record<string, unknown>) => loadConfig(process.cwd(), { dataDir, overrides: o });
    assert.deepEqual(await automationTick(store, mk({})), { queued: 0, advanced: 0, published: 0, blocked: {}, errors: [] }); assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM uploads')!.n, 0, 'autoQueue off => nothing queued');
    const gatesOff = mk({ automation: { autoQueue: true } }); const t1 = await automationTick(store, gatesOff); assert.equal(t1.queued, 1); assert.ok((t1.blocked.PUBLISH_DISABLED ?? 0) >= 1); assert.equal(f.log.length, 0, 'gates off => ZERO network calls');
    const on = mk({ automation: { autoQueue: true }, gates: { publishEnabled: true } });
    const t2 = await automationTick(store, on); assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=1')!.state, 'UPLOAD_VERIFYING', JSON.stringify(t2));
    const t3 = await automationTick(store, on); assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=1')!.state, 'UNLISTED_VERIFIED'); assert.ok((t3.blocked.NEEDS_APPROVAL ?? 0) >= 1, 'no autoApprove => waits for owner');
    assert.equal(f.videos.get('vid_sess1').status.privacyStatus, 'unlisted');
    const pubOff = mk({ automation: { autoQueue: true, autoApprove: true }, gates: { publishEnabled: true } });
    const t4 = await automationTick(store, pubOff, new Date('2030-01-01T00:00:00Z')); assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=1')!.state, 'SCHEDULED_OR_APPROVED'); assert.ok((t4.blocked.PUBLIC_DISABLED ?? 0) >= 1); assert.equal(f.videos.get('vid_sess1').status.privacyStatus, 'unlisted', 'public gate still protects');
    const full = mk({ automation: { autoQueue: true, autoApprove: true }, gates: { publishEnabled: true, publicVisibilityAllowed: true } });
    const t5 = await automationTick(store, full, new Date('2030-01-01T00:00:00Z')); assert.equal(t5.published, 1, JSON.stringify(t5));
    const v = f.videos.get('vid_sess1'); assert.equal(v.status.privacyStatus, 'private'); assert.ok(v.updateBody.status.publishAt, 'scheduled via publishAt');
    assert.ok(new Date(v.updateBody.status.publishAt).getTime() > Date.parse('2030-01-01T00:00:00Z'));
    assert.equal((await automationTick(store, full)).queued, 0, 'never queues the same clip twice');
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
