import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { capDescriptionHashtags, validateMetadata } from '../src/seo/metadata.ts';
import { queueUpload, advanceUpload, DryRunAdapter, type ClipFacts } from '../src/publish/machine.ts';
import { automationTick } from '../src/publish/service.ts';
import { YouTubeAdapter } from '../src/publish/youtube.ts';
import { TokenProvider } from '../src/publish/oauth.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { tmpDir } from './helpers.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const facts: ClipFacts = { width: 1080, height: 1920, duration: 30, title: 't', description: 'd', qcPass: true, authorized: true };
const seed = (file = '/tmp/o1.mp4') => { const s = new Store(':memory:'); s.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,10,.5,'c')`); s.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1',?,1)`, file); return s; };

test('50-hashtag SEO pack is capped to 15 real #tags (rest become plain words) so metadata is never rejected again', () => {
  const tags = Array.from({ length: 50 }, (_, i) => `#tag${i}`).join(' '); const d = `about this clip\n\n${tags}`;
  const out = capDescriptionHashtags(d); assert.equal((out.match(/(^|\s)#\w+/g) ?? []).length, 15); assert.ok(out.includes('tag49'), 'words kept for search');
  assert.deepEqual(validateMetadata({ title: 'x #Shorts', description: out, tags: ['a'] } as never), []); assert.ok(validateMetadata({ title: 'x', description: d, tags: [] } as never).length > 0);
});

test('self-heal: metadata jobs that died on the hashtag rule are re-queued exactly once', async () => {
  const s = seed(); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() });
  s.exec(`INSERT INTO jobs(kind, key, state, attempts, last_error) VALUES ('meta','meta:1','DEAD',5,'metadata invalid: too many #hashtags in the description (YouTube ignores all if >15)')`);
  s.exec(`INSERT INTO jobs(kind, key, state, attempts, last_error) VALUES ('meta','meta:2','DEAD',5,'something else')`);
  await automationTick(s, cfg); const st = (k: string) => s.get<{ state: string }>('SELECT state FROM jobs WHERE key=?', k)!.state;
  assert.equal(st('meta:1'), 'PENDING'); assert.equal(st('meta:2'), 'DEAD', 'unrelated failures are left alone');
  s.exec(`UPDATE jobs SET state='DEAD' WHERE key='meta:1'`); await automationTick(s, cfg); assert.equal(st('meta:1'), 'DEAD', 'one-time only');
});

test('a video the platform deleted after upload is uploaded again (max 2x), then fails with a clear reason', async () => {
  const s = seed(); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { gates: { publishEnabled: true, publicVisibilityAllowed: true } } }); let uploads = 0;
  const ad = Object.assign(new DryRunAdapter(), { upload: async () => ({ remoteId: `r${++uploads}` }), verify: async (id: string) => { throw new Error(`remote video ${id} not found`); } });
  const id = queueUpload(s, 1, 'youtube_shorts'); const run = () => advanceUpload(s, cfg, ad as never, id, { facts }).then((x) => x, (e: Error) => e.message);
  for (let i = 0; i < 12; i++) { const r = await run(); if (typeof r === 'string' && /vanished|2 baar/.test(r)) { assert.match(r, /2 baar hata di/); break; } }
  assert.equal(uploads, 3, 'original + 2 re-uploads, then it stops');
});

test('YouTube uploadLimitExceeded pauses only that channel login (no retry storm, no API call while paused)', async () => {
  const dataDir = tmpDir(); const s = new Store(':memory:'); const sec = SecretStore.forData(dataDir); sec.write('youtube-b', { refresh_token: 'r', client_id: 'c', client_secret: 's' });
  const f = join(tmpDir(), 'v.mp4'); writeFileSync(f, Buffer.alloc(300_000)); let calls = 0; const old = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request) => { const url = String(u); calls++; if (/oauth2|token/.test(url)) return new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 }); return new Response(JSON.stringify({ error: { errors: [{ reason: 'uploadLimitExceeded' }], message: 'limit' } }), { status: 403 }); }) as typeof fetch;
  try {
    const a = new YouTubeAdapter(s, new TokenProvider(sec, 'youtube-b')); const up = () => a.upload({ filePath: f, title: 't', description: 'd', tags: [], visibility: 'unlisted', idempotencyKey: 'k1' }).then(() => 'ok', (e: Error) => e.message);
    assert.match(await up(), /^QUOTA_EXCEEDED.*upload limit/i); const n = calls; assert.match(await up(), /^QUOTA_EXCEEDED/); assert.equal(calls, n, 'second attempt made no network call');
    const other = new YouTubeAdapter(s, new TokenProvider(sec, 'youtube')); assert.doesNotMatch(await other.upload({ filePath: f, title: 't', description: 'd', tags: [], visibility: 'unlisted', idempotencyKey: 'k2' }).then(() => 'ok', (e: Error) => e.message), /upload limit/, 'another channel is not paused');
  } finally { globalThis.fetch = old; }
});
