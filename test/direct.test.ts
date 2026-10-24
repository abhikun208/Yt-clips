import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { TelegramAdapter, DiscordAdapter, MastodonAdapter, ManualAdapter, saveCredentials, markPosted } from '../src/publish/direct.ts';
import { advanceUpload, queueUpload } from '../src/publish/machine.ts';
import { tmpDir } from './helpers.ts';

async function body(req: IncomingMessage) { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c).toString('latin1'); }
async function fake() {
  const log: { url: string; auth?: string; idem?: string; body: string }[] = []; let mediaPolls = 0;
  const srv = createServer(async (req, res) => {
    const b = await body(req); log.push({ url: req.url ?? '', auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string | undefined, body: b });
    const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url?.includes('/sendMessage')) return send(200, { ok: true, result: { message_id: 1 } });
    if (req.url?.includes('/sendVideo')) return send(200, { ok: true, result: { message_id: 77, chat: { id: -100123 } } });
    if (req.url?.startsWith('/api/webhooks/')) return send(200, { id: '555' });
    if (req.url === '/api/v2/media') return send(202, { id: '9' });
    if (req.url === '/api/v1/media/9') return send(++mediaPolls < 2 ? 206 : 200, { id: '9' });
    if (req.url === '/api/v1/statuses') return send(200, { id: '321', url: 'https://m.example/@x/321' });
    send(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { base, log, close: () => srv.close() };
}
const stage = async (a: { upload(x: any): Promise<{ remoteId: string }> }, file: string, key: string) => (await a.upload({ filePath: file, title: 'Clutch 1v4', description: 'booyah', tags: [], visibility: 'unlisted', idempotencyKey: key })).remoteId;

test('direct posters: staged first, nothing sent until publish; local schedule waits; one request only (crash-safe); fake servers', async () => {
  const f = await fake(); const old = { ...process.env }; Object.assign(process.env, { TELEGRAM_API_BASE: f.base, YT_CLIPS_ALLOW_LOOPBACK_HTTP: '1', MASTODON_POLL_MS: '5' });
  try {
    const file = join(tmpDir(), 'v.mp4'); writeFileSync(file, Buffer.alloc(2048, 7)); const store = new Store(':memory:');
    const tg = new TelegramAdapter(store, { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '@chan' }); const id = await stage(tg, file, 'k1');
    assert.equal(f.log.length, 0, 'staging touches no network'); assert.deepEqual(await tg.verify(id, { title: 'Clutch 1v4' }), { processed: true, metadataMatches: true, visibility: 'unlisted' });
    await assert.rejects(tg.publish(id, new Date(Date.now() + 3600_000)), /^Error: WAIT_SCHEDULE/); assert.equal(f.log.length, 0);
    const r1 = await tg.publish(id, null); const r2 = await tg.publish(id, null); assert.equal(f.log.length, 1, 'second publish does not re-send'); assert.deepEqual(r1, r2); assert.match(String(r1 && r1.remoteId), /^telegram:-100123:77$/);
    assert.ok(f.log[0]!.body.includes('name="video"') && f.log[0]!.body.includes('Clutch 1v4') && f.log[0]!.body.includes('@chan'));
    f.log.length = 0; const dc = new DiscordAdapter(store, { webhookUrl: `${f.base}/api/webhooks/1/abc-DEF` }); const did = await stage(dc, file, 'k2'); const dr = await dc.publish(did, null);
    assert.equal(dr && dr.remoteId, 'discord:555'); assert.ok(f.log[0]!.url.includes('wait=true') && f.log[0]!.body.includes('files[0]') && f.log[0]!.body.includes('"parse":[]'));
    f.log.length = 0; const ms = new MastodonAdapter(store, { instance: f.base, accessToken: 'tok-secret-123' }); const mid = await stage(ms, file, 'k3'); const mr = await ms.publish(mid, null);
    assert.equal(mr && mr.remoteId, 'mastodon:https://m.example/@x/321'); assert.deepEqual(f.log.map((x) => x.url), ['/api/v2/media', '/api/v1/media/9', '/api/v1/media/9', '/api/v1/statuses']);
    assert.ok(f.log.every((x) => x.auth === 'Bearer tok-secret-123')); assert.ok(f.log[3]!.idem && f.log[3]!.body.includes('"media_ids":["9"]'));
  } finally { f.close(); process.env = old; }
});

test('machine: direct platform is gate-blocked with gates off (zero traffic); manual platform needs no gate, raises a task, owner marks posted', async () => {
  const f = await fake(); const old = { ...process.env }; Object.assign(process.env, { TELEGRAM_API_BASE: f.base });
  try {
    const dir = tmpDir(); const file = join(dir, 'v.mp4'); writeFileSync(file, Buffer.alloc(2048, 1)); const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: dir });
    store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
    store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,'{}')`, file);
    const facts = { width: 720, height: 1280, duration: 20, title: 'T', description: 'D', qcPass: true, authorized: true };
    const ut = queueUpload(store, 1, 'telegram'); const tg = new TelegramAdapter(store, { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '@chan' });
    assert.equal(await advanceUpload(store, cfg, tg, ut, { facts }), 'UPLOAD_PENDING'); await assert.rejects(advanceUpload(store, cfg, tg, ut, { facts }), /PUBLISH_DISABLED/); assert.equal(f.log.length, 0);
    const um = queueUpload(store, 1, 'instagram_reels'); const man = new ManualAdapter('instagram_reels'); let st = '';
    for (let i = 0; i < 8 && st !== 'SCHEDULED_OR_APPROVED'; i++) st = await advanceUpload(store, cfg, man, um, { facts, approve: true });
    assert.equal(st, 'SCHEDULED_OR_APPROVED'); await assert.rejects(advanceUpload(store, cfg, man, um, { facts }), /^Error: MANUAL_POST_REQUIRED/);
    assert.throws(() => markPosted(store, ut, 'https://x.example/1'), /manual/); assert.throws(() => markPosted(store, um, 'javascript:alert(1)'), /invalid/);
    markPosted(store, um, 'https://instagram.com/reel/abc'); assert.deepEqual({ ...(store.get('SELECT state, remote_id FROM uploads WHERE id=?', um) as object) }, { state: 'PUBLISHED', remote_id: 'https://instagram.com/reel/abc' });
    assert.equal(f.log.length, 0);
  } finally { f.close(); process.env = old; }
});

test('credential vault: validated, stored in the secret store, per-channel name; bad shapes and non-https rejected', () => {
  const sec = new SecretStore(join(tmpDir(), 's'), 'unit-test-key-123'); const old = process.env.YT_CLIPS_ALLOW_LOOPBACK_HTTP; delete process.env.YT_CLIPS_ALLOW_LOOPBACK_HTTP;
  try {
    saveCredentials(sec, 'telegram', { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '-1001234567890' }, 'telegram-decider'); assert.equal(sec.read<{ chatId: string }>('telegram-decider')!.chatId, '-1001234567890'); assert.equal(sec.read('telegram'), null);
    assert.throws(() => saveCredentials(sec, 'telegram', { botToken: 'nope', chatId: '@abcde' }), /invalid/);
    assert.throws(() => saveCredentials(sec, 'discord', { webhookUrl: 'https://evil.example/api/webhooks/1/abc' }), /host/);
    assert.throws(() => saveCredentials(sec, 'discord', { webhookUrl: 'http://discord.com/api/webhooks/1/abc' }), /https/);
    assert.throws(() => saveCredentials(sec, 'mastodon', { instance: 'http://m.example', accessToken: 'abcdefgh' }), /https/);
    saveCredentials(sec, 'discord', { webhookUrl: 'https://discord.com/api/webhooks/123/abc-DEF_1' }); saveCredentials(sec, 'mastodon', { instance: 'https://mastodon.social/anything', accessToken: 'abcdefgh' });
    assert.equal(sec.read<{ instance: string }>('mastodon')!.instance, 'https://mastodon.social'); assert.throws(() => saveCredentials(sec, 'instagram_reels', {}), /no stored credentials/);
  } finally { if (old) process.env.YT_CLIPS_ALLOW_LOOPBACK_HTTP = old; }
});

import { secretsFor } from '../src/publish/service.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
test('secrets: auto-generated key (0600) encrypts new secrets, legacy plaintext is migrated, key reused on restart', () => {
  const old = process.env.YT_CLIPS_SECRET_KEY; delete process.env.YT_CLIPS_SECRET_KEY;
  try {
    const dir = tmpDir(); new SecretStore(join(dir, 'secrets'), undefined).write('youtube', { refresh_token: 'LEGACY-PLAIN-TOKEN' });
    assert.ok(readFileSync(join(dir, 'secrets', 'youtube.json'), 'utf8').includes('LEGACY-PLAIN-TOKEN'));
    const cfg = loadConfig(process.cwd(), { dataDir: dir }); const s = secretsFor(cfg); assert.equal(s.encrypted, true);
    assert.ok(!readFileSync(join(dir, 'secrets', 'youtube.json'), 'utf8').includes('LEGACY-PLAIN-TOKEN'), 'legacy file re-encrypted');
    assert.equal(s.read<{ refresh_token: string }>('youtube')!.refresh_token, 'LEGACY-PLAIN-TOKEN');
    assert.equal(statSync(join(dir, '.keys', 'secret.key')).mode & 0o777, 0o600);
    s.write('telegram', { botToken: 'SECRET-BOT' }); assert.ok(!readdirSync(join(dir, 'secrets')).some((f) => readFileSync(join(dir, 'secrets', f), 'utf8').includes('SECRET-BOT')));
    assert.equal(secretsFor(cfg).read<{ botToken: string }>('telegram')!.botToken, 'SECRET-BOT', 'same key reused on next start');
  } finally { if (old !== undefined) process.env.YT_CLIPS_SECRET_KEY = old; }
});

import { notify } from '../src/notify.ts';
test('notify: owner Telegram message once per key; silent when not configured; failures never throw', async () => {
  const f = await fake(); const old = { ...process.env }; Object.assign(process.env, { TELEGRAM_API_BASE: f.base });
  try {
    const dir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir: dir }); const store = new Store(':memory:');
    assert.equal(await notify(store, cfg, 'k', 'hi'), false); assert.equal(f.log.length, 0, 'not configured => no traffic');
    saveCredentials(secretsFor(cfg), 'notify', { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '99887766' });
    assert.equal(await notify(store, cfg, 'k', 'clip ready'), true); assert.equal(await notify(store, cfg, 'k', 'clip ready'), false, 'deduped'); assert.equal(f.log.length, 1);
    process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:1'; assert.equal(await notify(store, cfg, 'k2', 'x'), false);
  } finally { f.close(); process.env = old; }
});
