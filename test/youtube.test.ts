import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { startDeviceFlow, pollDeviceFlow, TokenProvider } from '../src/publish/oauth.ts';
import { YouTubeAdapter, quotaDay } from '../src/publish/youtube.ts';
import { queueUpload, advanceUpload, type ClipFacts } from '../src/publish/machine.ts';
import { loadConfig } from '../src/config.ts';
import { startFake, type Fake } from './fakeGoogle.ts';
import { tmpDir } from './helpers.ts';

async function env<T>(f: Fake, fn: () => Promise<T>): Promise<T> {
  const keys = { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'cid', YT_OAUTH_CLIENT_SECRET: 'csec' } as Record<string, string>;
  const old: Record<string, string | undefined> = {}; for (const k of Object.keys(keys)) { old[k] = process.env[k]; process.env[k] = keys[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
function setup(f: Fake, o: ConstructorParameters<typeof YouTubeAdapter>[2] = {}) {
  const dir = tmpDir(); const secrets = new SecretStore(join(dir, 'secrets'), undefined); secrets.write('youtube', { refresh_token: 'REFRESH-TOKEN-XYZ' });
  const store = new Store(':memory:'); const ad = new YouTubeAdapter(store, new TokenProvider(secrets), { chunkBytes: 256 * 1024, sleep: async () => {}, ...o });
  const file = join(dir, 'clip.mp4'); writeFileSync(file, randomBytes(700 * 1024)); return { dir, secrets, store, ad, file };
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const up = (file: string, key = 'k1') => ({ filePath: file, title: 'My Title', description: 'desc', tags: ['a', 'b'], visibility: 'unlisted' as const, idempotencyKey: key });

test('secrets: encrypted at rest with AES-GCM, 0600 perms, wrong key fails loudly, plaintext never on disk', () => {
  const d = tmpDir(); const s = new SecretStore(d, 'a-strong-passphrase'); s.write('youtube', { refresh_token: 'SUPER-SECRET-TOKEN' });
  const raw = readFileSync(join(d, 'youtube.json'), 'utf8'); assert.ok(!raw.includes('SUPER-SECRET-TOKEN')); assert.equal(statSync(join(d, 'youtube.json')).mode & 0o777, 0o600);
  assert.equal(s.read<{ refresh_token: string }>('youtube')!.refresh_token, 'SUPER-SECRET-TOKEN'); assert.equal(s.encrypted, true);
  assert.throws(() => new SecretStore(d, 'wrong').read('youtube'), /AUTH_SECRET_KEY_WRONG/); assert.throws(() => new SecretStore(d, undefined).read('youtube'), /AUTH_SECRET_KEY_REQUIRED/);
  assert.equal(new SecretStore(d, 'x').read('nope'), null);
  const p = new SecretStore(tmpDir(), undefined); p.write('a', { k: 1 }); assert.equal(p.encrypted, false); assert.deepEqual(p.read('a'), { k: 1 });
});

test('device flow: start -> pending -> success persists refresh token; refresh gives bearer; revoked => AUTH_REVOKED', async () => {
  const f = await startFake();
  try { await env(f, async () => {
    const secrets = new SecretStore(tmpDir(), undefined); const d = await startDeviceFlow('cid'); assert.equal(d.user_code, 'ABCD-EFGH'); assert.match(d.verification_url, /google\.com\/device/);
    assert.deepEqual(await pollDeviceFlow(secrets, 'cid', 'csec', d.device_code), { status: 'pending' });
    const ok = await pollDeviceFlow(secrets, 'cid', 'csec', d.device_code); assert.equal(ok.status, 'ok');
    const tp = new TokenProvider(secrets); assert.equal(tp.connected(), true); const t1 = await tp.accessToken(); assert.equal(await tp.accessToken(), t1, 'cached');
    f.opts.revoked = true; await assert.rejects(new TokenProvider(secrets).accessToken(), /AUTH_REVOKED/);
    assert.equal(new TokenProvider(new SecretStore(tmpDir(), undefined)).connected(), false);
    await assert.rejects(new TokenProvider(new SecretStore(tmpDir(), undefined)).accessToken(), /AUTH_NOT_CONNECTED/);
  }); } finally { await f.close(); }
});

test('resumable upload: multi-chunk, byte-exact, survives a 503 AND a chunk stored-but-response-lost, no gaps/overlaps', async () => {
  const f = await startFake(); f.opts.failChunkOnce = 2; f.opts.dropAfterStoreOnce = 3;
  try { await env(f, async () => {
    const { ad, file, store } = setup(f); const r = await ad.upload(up(file));
    assert.match(r.remoteId, /^vid_sess1$/); assert.equal(sha(f.sessions.get('sess1')!.got), sha(readFileSync(file)), 'server has the exact bytes');
    assert.equal(f.log.filter((x) => x.path === '/upload/youtube/v3/videos').length, 1, 'one session init');
    const init = f.sessions.get('sess1')!.init; assert.equal(init.snippet.title, 'My Title'); assert.deepEqual(init.snippet.tags, ['a', 'b']); assert.equal(init.status.privacyStatus, 'unlisted'); assert.equal(init.status.selfDeclaredMadeForKids, false);
    const initReq = f.log.find((x) => x.path === '/upload/youtube/v3/videos')!; assert.equal(initReq.headers['x-upload-content-length'], String(700 * 1024)); assert.equal(initReq.query.get('uploadType'), 'resumable');
    assert.equal(store.get<{ remote_id: string }>('SELECT remote_id FROM upload_sessions WHERE key=?', 'k1')!.remote_id, r.remoteId, 'id persisted immediately');
  }); } finally { await f.close(); }
});

test('idempotency: repeating upload() with the same key never uploads again; restart resumes the stored session', async () => {
  const f = await startFake();
  try { await env(f, async () => {
    const { ad, file, store, secrets } = setup(f); const a = await ad.upload(up(file)); const b = await ad.upload(up(file));
    assert.equal(a.remoteId, b.remoteId); assert.equal(f.sessions.size, 1);
    // simulate crash mid-upload: session row exists, nothing sent yet -> a NEW adapter instance (restart) must reuse the session, not open a second one
    const file2 = join(tmpDir(), 'c2.mp4'); writeFileSync(file2, randomBytes(300 * 1024));
    const ad1 = new YouTubeAdapter(store, new TokenProvider(secrets), { chunkBytes: 256 * 1024, sleep: async () => {}, maxRetries: 0 }); f.opts.failChunkOnce = f.chunkCount + 1;
    await assert.rejects(ad1.upload(up(file2, 'k2')), /upload chunk failed/); assert.equal(f.sessions.size, 2);
    const ad2 = new YouTubeAdapter(store, new TokenProvider(secrets), { chunkBytes: 256 * 1024, sleep: async () => {} }); const c = await ad2.upload(up(file2, 'k2'));
    assert.equal(f.sessions.size, 2, 'same session reused after restart'); assert.equal(sha(f.sessions.get('sess2')!.got), sha(readFileSync(file2))); assert.ok(c.remoteId);
  }); } finally { await f.close(); }
});

test('expired session (404) restarts once; init quota error => QUOTA_EXCEEDED (not a hard failure)', async () => {
  const f = await startFake();
  try { await env(f, async () => {
    const { ad, file } = setup(f); f.opts.expireSessionOnce = true; const r = await ad.upload(up(file)); assert.ok(r.remoteId); assert.equal(f.sessions.size >= 1, true);
    const s2 = setup(f); f.opts.initStatus = 403; await assert.rejects(s2.ad.upload(up(s2.file, 'q')), /QUOTA_EXCEEDED/);
  }); } finally { await f.close(); }
});

test('verify: NOT_READY while processing, then processed; title/visibility mismatch reported; failed/rejected is a hard error', async () => {
  const f = await startFake(); f.opts.processedAfterPolls = 2;
  try { await env(f, async () => {
    const { ad, file } = setup(f); const { remoteId } = await ad.upload(up(file));
    await assert.rejects(ad.verify(remoteId, { title: 'My Title', visibility: 'unlisted' }), /NOT_READY/); await assert.rejects(ad.verify(remoteId), /NOT_READY/);
    assert.deepEqual(await ad.verify(remoteId, { title: 'My Title', visibility: 'unlisted' }), { processed: true, visibility: 'unlisted', metadataMatches: true });
    assert.equal((await ad.verify(remoteId, { title: 'Other', visibility: 'unlisted' })).metadataMatches, false);
    assert.equal((await ad.verify(remoteId, { title: 'My Title', visibility: 'public' })).metadataMatches, false);
    await assert.rejects(ad.verify('nope'), /not found/); f.opts.uploadStatusFinal = 'rejected'; await assert.rejects(ad.verify(remoteId), /remote upload rejected/);
  }); } finally { await f.close(); }
});

test('publish: merges existing status (omitted fields would be reset), schedule = private+publishAt, now = public; thumbnail is best-effort', async () => {
  const f = await startFake();
  try { await env(f, async () => {
    const { ad, file } = setup(f); const { remoteId } = await ad.upload(up(file)); const jpg = join(tmpDir(), 't.jpg'); writeFileSync(jpg, randomBytes(2000));
    assert.equal(await ad.thumbnail(remoteId, jpg), true); f.opts.thumbStatus = 403; assert.equal(await ad.thumbnail(remoteId, jpg), false, 'rejected thumbnail does not throw');
    const at = new Date('2030-01-02T03:04:05Z'); await ad.publish(remoteId, at);
    let b = f.videos.get(remoteId).updateBody; assert.equal(b.id, remoteId); assert.equal(b.status.privacyStatus, 'private'); assert.equal(b.status.publishAt, at.toISOString());
    for (const k of ['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids']) assert.ok(k in b.status, `${k} preserved`);
    await ad.publish(remoteId, null); b = f.videos.get(remoteId).updateBody; assert.equal(b.status.privacyStatus, 'public'); assert.ok(!('publishAt' in b.status));
    assert.deepEqual(await ad.whoami(), { id: 'UC123', title: 'My Channel' });
  }); } finally { await f.close(); }
});

test('quota accounting: per-Pacific-day counters, hard stop at the cap, other pools unaffected', async () => {
  const f = await startFake();
  try { await env(f, async () => {
    let now = new Date('2026-10-20T20:00:00Z'); const { ad, file } = setup(f, { dailyUnits: 60, dailyInserts: 2, now: () => now });
    await ad.upload(up(file, 'a')); assert.equal(ad.quotaUsed('insert'), 1); await ad.upload(up(file, 'b')); await assert.rejects(ad.upload(up(file, 'c')), /QUOTA_EXCEEDED: insert/);
    assert.equal(ad.quotaUsed('units'), 0);
    const { remoteId } = await ad.upload(up(file, 'a')); await ad.publish(remoteId, null); assert.equal(ad.quotaUsed('units'), 51); await assert.rejects(ad.publish(remoteId, null), /QUOTA_EXCEEDED: units/);
    now = new Date('2026-10-21T20:00:00Z'); assert.equal(ad.quotaUsed('units'), 0, 'new Pacific day => fresh counters');
    assert.equal(quotaDay(new Date('2026-10-21T06:59:00Z')), '2026-10-20'); assert.equal(quotaDay(new Date('2026-10-21T07:01:00Z')), '2026-10-21');
    f.opts.quotaOnList = true; await assert.rejects(ad.verify(remoteId), /QUOTA_EXCEEDED/);
  }); } finally { await f.close(); }
});

test('FULL machine on the YouTube adapter: gates OFF make zero HTTP calls; gates ON => unlisted upload+thumbnail+verify (waits while processing) -> approval -> public only with its own gate', async () => {
  const f = await startFake(); f.opts.processedAfterPolls = 1;
  try { await env(f, async () => {
    const { ad, file, store } = setup(f); store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,10,.5,'c')`);
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1',?,1)`, file); const jpg = join(tmpDir(), 't.jpg'); writeFileSync(jpg, randomBytes(500));
    const facts: ClipFacts = { width: 1080, height: 1920, duration: 30, title: 'My Title', description: 'd', qcPass: true, authorized: true, tags: ['x'], thumbnailPath: jpg };
    const off = loadConfig(process.cwd(), { dataDir: tmpDir() }); const id = queueUpload(store, 1, 'youtube_shorts');
    assert.equal(await advanceUpload(store, off, ad, id, { facts }), 'UPLOAD_PENDING'); await assert.rejects(advanceUpload(store, off, ad, id, { facts }), /PUBLISH_DISABLED/); assert.equal(f.log.length, 0, 'ZERO network calls while gates are off');
    const on = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { gates: { publishEnabled: true } } });
    assert.equal(await advanceUpload(store, on, ad, id, { facts }), 'UPLOADING'); assert.equal(await advanceUpload(store, on, ad, id, { facts }), 'UPLOAD_VERIFYING');
    assert.ok(f.log.some((x) => x.path.includes('thumbnails/set')), 'thumbnail sent after upload');
    await assert.rejects(advanceUpload(store, on, ad, id, { facts }), /NOT_READY/); assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'UPLOAD_VERIFYING', 'still processing is NOT a failure');
    assert.equal(await advanceUpload(store, on, ad, id, { facts }), 'UNLISTED_VERIFIED');
    await assert.rejects(advanceUpload(store, on, ad, id, { facts }), /NEEDS_APPROVAL/);
    assert.equal(await advanceUpload(store, on, ad, id, { facts, approve: true }), 'SCHEDULED_OR_APPROVED');
    await assert.rejects(advanceUpload(store, on, ad, id, { facts }), /PUBLIC_DISABLED/); assert.equal(f.videos.get('vid_sess1').status.privacyStatus, 'unlisted', 'still unlisted on the platform');
    const pub = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { gates: { publishEnabled: true, publicVisibilityAllowed: true } } });
    assert.equal(await advanceUpload(store, pub, ad, id, { facts }), 'PUBLISHED'); assert.equal(f.videos.get('vid_sess1').status.privacyStatus, 'public');
    assert.ok(f.log.filter((x) => x.headers.authorization).every((x) => /^Bearer fake-access-/.test(String(x.headers.authorization))));
  }); } finally { await f.close(); }
});
