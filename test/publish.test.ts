import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { queueUpload, advanceUpload, DryRunAdapter, validateForPlatform, type ClipFacts } from '../src/publish/machine.ts';
import { classifyComment, draftReply, ingestComment, postApprovedReply } from '../src/comments/comments.ts';
import { buildMetadata, validateMetadata, extractKeywords } from '../src/seo/metadata.ts';
import { planSlots, preferredHours, dayKey, hourIn } from '../src/schedule/scheduler.ts';
import { tmpDir } from './helpers.ts';

function seed(qc = 1) {
  const s = new Store(':memory:');
  s.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`);
  s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,10,.5,'c')`);
  s.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1','/tmp/o1.mp4',?)`, qc);
  return s;
}
const facts: ClipFacts = { width: 1080, height: 1920, duration: 30, title: 't', description: 'd', qcPass: true, authorized: true };
const on = (g: object) => loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { gates: g } });

test('uploads blocked while gates are OFF, with state preserved (not marked failed)', async () => {
  const s = seed(); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() }); const ad = new DryRunAdapter();
  const id = queueUpload(s, 1, 'youtube_shorts');
  assert.equal(await advanceUpload(s, cfg, ad, id, { facts }), 'UPLOAD_PENDING');
  await assert.rejects(advanceUpload(s, cfg, ad, id, { facts }), /PUBLISH_DISABLED/);
  assert.equal(s.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'UPLOAD_PENDING');
  assert.deepEqual(ad.calls, [], 'no remote call made');
});

test('full state machine with dry-run adapter: unlisted verify before publish, approval required, public gate separate', async () => {
  const s = seed(); const ad = new DryRunAdapter(); const cfg = on({ publishEnabled: true });
  const id = queueUpload(s, 1, 'youtube_shorts');
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) seen.push(await advanceUpload(s, cfg, ad, id, { facts }));
  assert.deepEqual(seen, ['UPLOAD_PENDING', 'UPLOADING', 'UPLOAD_VERIFYING', 'UNLISTED_VERIFIED']);
  assert.equal(s.get<{ visibility: string }>('SELECT visibility FROM uploads WHERE id=?', id)!.visibility, 'unlisted', 'uploaded unlisted first');
  await assert.rejects(advanceUpload(s, cfg, ad, id, { facts }), /NEEDS_APPROVAL/);
  assert.equal(await advanceUpload(s, cfg, ad, id, { facts, approve: true }), 'SCHEDULED_OR_APPROVED');
  await assert.rejects(advanceUpload(s, cfg, ad, id, { facts }), /PUBLIC_DISABLED/, 'public needs its own gate');
  assert.ok(!ad.calls.some((c) => c.startsWith('publish')));
  const cfg2 = on({ publishEnabled: true, publicVisibilityAllowed: true });
  assert.equal(await advanceUpload(s, cfg2, ad, id, { facts }), 'PUBLISHED');
});

test('idempotency: same clip+platform never queues twice; adapter upload key is stable', async () => {
  const s = seed(); assert.equal(queueUpload(s, 1, 'youtube_shorts'), queueUpload(s, 1, 'youtube_shorts'));
  const ad = new DryRunAdapter(); const a = await ad.upload({ filePath: '', title: '', description: '', tags: [], visibility: 'unlisted', idempotencyKey: 'k' }); const b = await ad.upload({ filePath: '', title: '', description: '', tags: [], visibility: 'unlisted', idempotencyKey: 'k' });
  assert.equal(a.remoteId, b.remoteId);
});

test('QC-failed clip, unauthorized source, too-long, non-vertical are all rejected', () => {
  assert.ok(validateForPlatform('youtube_shorts', { ...facts, qcPass: false }).length);
  assert.ok(validateForPlatform('youtube_shorts', { ...facts, authorized: false }).some((e) => /authoriz/.test(e)));
  assert.ok(validateForPlatform('youtube_shorts', { ...facts, duration: 500 }).length);
  assert.ok(validateForPlatform('tiktok', { ...facts, width: 1920, height: 1080 }).some((e) => /vertical/.test(e)));
  assert.ok(validateForPlatform('nope', facts)[0]!.includes('unknown'));
  assert.deepEqual(validateForPlatform('youtube_shorts', facts), []);
  assert.equal(queueUpload(seed(0), 1, 'tiktok') > 0, true);
});

test('failed upload is recorded FAILED and retryable', async () => {
  const s = seed(); const cfg = on({ publishEnabled: true });
  const bad = new DryRunAdapter(); bad.upload = async () => { throw new Error('network down'); };
  const id = queueUpload(s, 1, 'youtube_shorts');
  await advanceUpload(s, cfg, bad, id, { facts }); await advanceUpload(s, cfg, bad, id, { facts });
  await assert.rejects(advanceUpload(s, cfg, bad, id, { facts }), /network down/);
  assert.equal(s.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'FAILED');
  assert.equal(await advanceUpload(s, cfg, new DryRunAdapter(), id, { facts }), 'QC_PASSED', 'retry re-validates');
});

test('comments: classification, no reply to spam/abuse/PII, dedupe, posting needs opt-in + approval', async () => {
  assert.equal(classifyComment('visit https://spam.biz now'), 'spam'); assert.equal(classifyComment('kaise banaya ye?'), 'question'); assert.equal(classifyComment('mast video'), 'praise');
  assert.equal(draftReply('spam', 'x'), null); assert.equal(draftReply('question', 'call 9876543210 kaise?'), null, 'PII -> no draft');
  const s = new Store(':memory:'); const a = ingestComment(s, 'yt', 'c1', 'kaise karte ho?'); const b = ingestComment(s, 'yt', 'c1', 'kaise karte ho?');
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true);
  await assert.rejects(postApprovedReply(s, loadConfig(process.cwd(), { dataDir: tmpDir() }), a.id, async () => {}), /COMMENTS_DISABLED/);
  const cfg = on({ commentsAutoPost: true });
  await assert.rejects(postApprovedReply(s, cfg, a.id, async () => {}), /not approved/);
  s.exec(`UPDATE comments SET status='approved' WHERE id=?`, a.id);
  let posted = 0; await postApprovedReply(s, cfg, a.id, async () => { posted++; }); assert.equal(posted, 1);
});

test('metadata: honest (no invented links), valid limits, keywords not stuffed', () => {
  const m = buildMetadata({ transcript: 'Ye ek secret hai. Secret ka raaz kya hai yaar, bahut dilchasp kahani hai', category: 'shock', language: 'hinglish' });
  assert.deepEqual(validateMetadata(m), []); assert.ok(m.title.length <= 100); assert.ok(!/https?:\/\//.test(m.description), 'no links unless owner configured');
  assert.ok(m.warnings.some((w) => /no owner links/.test(w))); assert.ok(m.hashtags.length <= 5);
  const withLink = buildMetadata({ transcript: '', category: 'general', language: 'unknown', ownerLinks: [{ label: 'Instagram', url: 'https://instagram.com/owner' }] });
  assert.match(withLink.description, /instagram\.com\/owner/); assert.ok(withLink.warnings.some((w) => /no transcript/.test(w)));
  assert.ok(extractKeywords('the the the cat cat dog', 5).length <= 5);
});

test('scheduler: caps, gaps, quiet hours, baseline vs measured, no past slots', () => {
  const cfg = { perDayCap: 2, minGapMinutes: 180, quietHours: [0, 6] as [number, number], baselineHours: [12, 18, 21], jitterMinutes: 20 };
  const from = new Date('2026-10-21T00:00:00Z'); const tz = 'Asia/Kolkata';
  const slots = planSlots(8, { from, tz, cfg, rnd: () => 0.5 });
  assert.equal(slots.length, 8); assert.ok(slots.every((s) => s.basis === 'baseline'));
  const perDay = new Map<string, number>(); for (const s of slots) { perDay.set(dayKey(tz, s.at), (perDay.get(dayKey(tz, s.at)) ?? 0) + 1); assert.ok(s.at >= from); assert.ok(!(hourIn(tz, s.at) < 6)); }
  assert.ok([...perDay.values()].every((n) => n <= 2));
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i]!.at.getTime() - slots[i - 1]!.at.getTime() >= 180 * 60_000);
  const measured = preferredHours([{ hour: 9, views: 900, samples: 6 }, { hour: 20, views: 1200, samples: 5 }, { hour: 3, views: 9999, samples: 5 }], cfg);
  assert.equal(measured.basis, 'measured'); assert.ok(!measured.hours.includes(3), 'quiet hours excluded even if "best"');
  assert.equal(preferredHours([{ hour: 9, views: 10, samples: 1 }], cfg).basis, 'baseline', 'insufficient data -> conservative baseline');
  const again = planSlots(2, { from, tz, cfg, rnd: () => 0.5, existing: slots.slice(0, 2).map((s) => s.at) });
  assert.ok(again.every((a) => slots.slice(0, 2).every((e) => Math.abs(a.at.getTime() - e.at.getTime()) >= 180 * 60_000)));
});
