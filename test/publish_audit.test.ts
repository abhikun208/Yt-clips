import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { saveCredentials } from '../src/publish/direct.ts';
import { automationTick } from '../src/publish/service.ts';
import { publishAudit } from '../src/publish/audit.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';

async function vertical(out: string) { const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=270x480:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { timeoutMs: 60000 }); assert.equal(r.code, 0); }
const seed = (store: Store, file: string) => { store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1',?,1,?)`, file, JSON.stringify({ title: 'Clutch 1v4 #Shorts', description: 'd', tags: ['x'] })); };

test('audit names the exact blockers when mode is DRY_RUN and gates are closed (real stored state, exact fix text)', async () => {
  const old = process.env.PUBLISH_MODE; delete process.env.PUBLISH_MODE;
  try {
    const dataDir = tmpDir(); const store = new Store(':memory:'); seed(store, '/x.mp4'); const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: false, platforms: ['telegram'] }, gates: { publishEnabled: false, publicVisibilityAllowed: false } } });
    const a = publishAudit(store, cfg); assert.equal(a.verdict, 'BLOCKED'); const t = a.lines.map((l) => l.text + ' ' + (l.fix ?? '')).join('\n');
    assert.match(t, /PUBLISH_MODE = DRY_RUN/); assert.match(t, /PUBLISH_MODE=PUBLIC/); assert.match(t, /publishEnabled/); assert.match(t, /publicVisibilityAllowed/); assert.match(t, /autoQueue/); assert.match(t, /autoApprove/); assert.equal(a.neverQueued.count, 1);
    store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key) VALUES (1,'telegram','UNLISTED_VERIFIED','k')`); assert.match(publishAudit(store, cfg).lines.map((l) => l.text).join('\n'), /1 upload\(s\) UNLISTED_VERIFIED par tumhari approval/);
  } finally { if (old !== undefined) process.env.PUBLISH_MODE = old; }
});

test('END TO END: with PUBLISH_MODE=PUBLIC + gates open + autoQueue, a QC-passed clip is queued, uploaded, verified and PUBLISHED on Telegram by the loop alone (fake Telegram API); audit says PUBLIC_READY', { timeout: 180_000 }, async () => {
  const sent: string[] = []; const srv = createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { if (req.url?.includes('/sendVideo')) sent.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: -100999 } } })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const old = { ...process.env };
  Object.assign(process.env, { PUBLISH_MODE: 'PUBLIC', TELEGRAM_API_BASE: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, YT_CLIPS_ALLOW_LOOPBACK_HTTP: '1' });
  try {
    const dataDir = tmpDir(); const f = join(tmpDir(), 'v.mp4'); await vertical(f); saveCredentials(SecretStore.forData(dataDir), 'telegram', { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '@chan' });
    const store = new Store(':memory:'); seed(store, f);
    const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: { autoQueue: true, autoApprove: true, platforms: ['telegram'], unlistedBufferMin: 0, blockGenericMetadata: false }, gates: { publishEnabled: true, publicVisibilityAllowed: true }, schedule: { jitterMinutes: 0, quietHours: [0, 0], minGapMinutes: 15, perDayCap: 20 } } });
    const a0 = publishAudit(store, cfg); assert.equal(a0.verdict, 'PUBLIC_READY', JSON.stringify(a0.lines));
    for (let i = 0; i < 25 && !sent.length; i++) { await automationTick(store, cfg); store.exec(`UPDATE uploads SET scheduled_at=? WHERE state='SCHEDULED_OR_APPROVED'`, new Date(Date.now() - 60_000).toISOString()); } // time-travel only the owner's slot: the loop itself must do everything else
    assert.equal(sent.length, 1, JSON.stringify(store.all('SELECT state, error FROM uploads'))); assert.equal(store.get<{ state: string }>('SELECT state FROM uploads')!.state, 'PUBLISHED');
    assert.equal(publishAudit(store, cfg).uploads.PUBLISHED, 1);
  } finally { srv.close(); process.env = old; }
});
