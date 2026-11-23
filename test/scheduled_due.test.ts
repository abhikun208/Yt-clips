import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { saveCredentials } from '../src/publish/direct.ts';
import { automationTick, advance, queueUpload } from '../src/publish/service.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';

async function vertical(out: string) {
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=270x480:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error('ffmpeg failed');
}

test('owner-scheduled post goes out at its due time even with autoQueue OFF; never before; exactly once; gates still protect', { timeout: 120_000 }, async () => {
  const sent: string[] = [];
  const srv = createServer((req, res) => { const c: Buffer[] = []; req.on('data', (x) => c.push(x as Buffer)); req.on('end', () => { if (req.url?.includes('/sendVideo')) sent.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { message_id: 5, chat: { id: -100999 } } })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const old = { ...process.env };
  Object.assign(process.env, { TELEGRAM_API_BASE: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, YT_CLIPS_ALLOW_LOOPBACK_HTTP: '1' });
  try {
    const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file);
    saveCredentials(SecretStore.forData(dataDir), 'telegram', { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '@chan' });
    const store = new Store(':memory:');
    store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Clutch 1v4 #Shorts', description: 'd', tags: ['x'] }));
    const open = { automation: { autoQueue: false, platforms: ['telegram'], unlistedBufferMin: 0, blockGenericMetadata: false }, gates: { publishEnabled: true, publicVisibilityAllowed: true } };
    const cfg = loadConfig(process.cwd(), { dataDir, overrides: open });
    // the owner walks one job through the manual flow and approves it for a time in the future
    const id = queueUpload(store, 1, 'telegram'); const due = new Date(Date.now() + 3 * 3600_000);
    for (let i = 0; i < 6 && store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state !== 'UNLISTED_VERIFIED'; i++) await advance(store, cfg, id);
    await advance(store, cfg, id, { scheduledAt: due });
    assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'SCHEDULED_OR_APPROVED');
    // 1) before the due time: the loop must wait, not post
    const t1 = await automationTick(store, cfg, new Date()); assert.equal(sent.length, 0, 'nothing is posted before the due time'); assert.ok((t1.blocked.WAIT_SCHEDULE ?? 0) >= 1, JSON.stringify(t1)); assert.equal(t1.queued, 0, 'autoQueue off: nothing new is queued');
    // 2) gates closed: even when due, nothing leaves
    const closed = loadConfig(process.cwd(), { dataDir, overrides: { ...open, gates: { publishEnabled: true, publicVisibilityAllowed: false } } });
    store.exec(`UPDATE uploads SET scheduled_at=? WHERE id=?`, new Date(Date.now() - 60_000).toISOString(), id);
    const t2 = await automationTick(store, closed); assert.equal(sent.length, 0, 'public gate off => zero platform traffic'); assert.ok((t2.blocked.PUBLIC_DISABLED ?? 0) >= 1, JSON.stringify(t2));
    // 3) due + gates open: it posts, once
    const t3 = await automationTick(store, cfg); assert.equal(t3.published, 1, JSON.stringify(t3) + ' ' + store.get<{ e: string }>('SELECT error e FROM uploads WHERE id=?', id)?.e); assert.equal(sent.length, 1);
    assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'PUBLISHED');
    await automationTick(store, cfg); assert.equal(sent.length, 1, 'never posted twice');
    // 4) an UNAPPROVED job is never pushed by the loop when autoQueue is off
    const id2 = queueUpload(store, 1, 'telegram'); assert.equal(id2, id, 'same clip+platform is one job (idempotent)');
  } finally { srv.close(); process.env = old; }
});

test('distribute-created jobs (explicit destination) are advanced by the loop even when the platform is not in automation.platforms and autoQueue is off', { timeout: 120_000 }, async () => {
  const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file); const store = new Store(':memory:');
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Clutch 1v4 #Shorts', description: 'd', tags: ['x'] }));
  const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: false, platforms: ['youtube_shorts'], blockGenericMetadata: false }, gates: { publishEnabled: false } } });
  const plain = queueUpload(store, 1, 'telegram'); store.exec(`UPDATE uploads SET state='QC_PASSED' WHERE id=?`, plain);
  const t = await automationTick(store, cfg); assert.equal(t.queued, 0);
  assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', plain)!.state, 'QC_PASSED', 'a job with no destination on an unlisted platform is left alone');
});

test('a distribute job for facebook_reels (destination bound) is picked up by the loop and is advanced by the loop, not left at QC_PASSED', { timeout: 120_000 }, async () => {
  const dataDir = tmpDir(); const file = join(tmpDir(), 'v.mp4'); await vertical(file); const store = new Store(':memory:');
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Clutch 1v4 #Shorts', description: 'd', tags: ['x'] }));
  store.exec(`INSERT INTO destinations(id, platform, external_id, name, secret_ref) VALUES ('d1','facebook','p1','My Page','facebook')`);
  SecretStore.forData(dataDir).write('facebook', { page_id: 'p1', access_token: 'tok-secret-1' });
  const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: false, platforms: ['youtube_shorts'], blockGenericMetadata: false }, gates: { publishEnabled: false } } });
  const id = queueUpload(store, 1, 'facebook_reels', undefined, 'd1');
  const t = await automationTick(store, cfg); assert.ok(t.advanced >= 1, JSON.stringify(t));
  assert.notEqual(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'QC_PASSED', 'the loop moved the distributed job on (without a Meta publish login it is the manual-post flow; with one it is the real adapter behind the same gates)');
});

test('slot planning is per platform account: a YouTube post does not push the same channel\'s Facebook slot away, but does space the next YouTube post', async () => {
  const { planFromStore } = await import('../src/schedule/analytics.ts'); const { mainChannel } = await import('../src/channels.ts');
  const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(':memory:'); const ch = mainChannel(store);
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1','/x.mp4',1,'{}')`);
  const from = new Date('2030-01-01T04:00:00Z'); const plan = (platform: string) => planFromStore(store, { n: 1, tz: cfg.timezone, cfg: { ...cfg.schedule, jitterMinutes: 0 }, from, platform, channelId: ch.id }).slots[0]!.at.getTime();
  const base = plan('youtube_shorts'); assert.equal(plan('facebook_reels'), base, 'empty calendar: same first slot');
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, channel_id, scheduled_at) VALUES (1,'youtube_shorts','SCHEDULED_OR_APPROVED','k1',?,?)`, ch.id, new Date(base).toISOString());
  assert.equal(plan('facebook_reels'), base, 'Facebook slot is NOT pushed by the YouTube post'); assert.ok(plan('youtube_shorts') > base, 'the next YouTube post is spaced after the first');
});
