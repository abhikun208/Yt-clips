import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { cleanRanges, fixArgs, recordClaim, claimSummary, reliability } from '../src/publish/claims.ts';

function seed(store: Store, n = 1) {
  const src = store.exec(`INSERT INTO sources(kind, uri, title, authorized) VALUES ('youtube_video','u1','Serial',1)`).lastId;
  const vid = store.exec(`INSERT INTO videos(source_id, path, fingerprint) VALUES (?, '/x.mp4', 'fp')`, src).lastId;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const cand = store.exec(`INSERT INTO candidates(video_id, start_sec, end_sec, score, fingerprint) VALUES (?,0,30,1,?)`, vid, `c${i}`).lastId;
    ids.push(store.exec(`INSERT INTO clips(candidate_id, output_id) VALUES (?,?)`, cand, `o${i}`).lastId);
  }
  return { src, ids };
}

test('ranges are cleaned, merged, validated', () => {
  assert.deepEqual(cleanRanges([{ from: 5, to: 8 }, { from: 1, to: 3 }, { from: 7, to: 10 }]), [{ from: 1, to: 3 }, { from: 5, to: 10 }]);
  assert.throws(() => cleanRanges([{ from: 5, to: 2 }]));
  assert.throws(() => cleanRanges('x'));
  assert.deepEqual(cleanRanges([{ from: 28, to: 99 }], 30), [{ from: 28, to: 30 }]);
});

test('audio claim → mute filter; visual → cut filter', () => {
  assert.match(fixArgs('a', 'b', 'audio', [{ from: 1, to: 2 }]).join(' '), /volume=enable='between\(t,1,2\)':volume=0/);
  assert.match(fixArgs('a', 'b', 'visual', [{ from: 1, to: 2 }]).join(' '), /select='not\(between\(t,1,2\)\)'/);
});

test('claim rejects clip, counts per source, pauses source after 3', async () => {
  const store = new Store(':memory:'); const { src, ids } = seed(store, 3);
  for (let i = 0; i < 3; i++) { const r = await recordClaim(store, ids[i]!, { kind: 'audio', note: 'tmkoc' }); assert.equal(r.sourceClaims, i + 1); assert.equal(r.sourcePaused, i === 2); }
  assert.equal(store.get<{ status: string }>('SELECT status FROM sources WHERE id=?', src)!.status, 'paused');
  assert.equal(store.get<{ review: string }>('SELECT review FROM clips WHERE id=?', ids[0]!)!.review, 'rejected');
  assert.equal(claimSummary(store).bySource[0]!.claims, 3);
  await assert.rejects(recordClaim(store, 999, { kind: 'audio' }), /not found/);
  await assert.rejects(recordClaim(store, ids[0]!, { kind: 'bogus' as never }), /invalid/);
});

import { advanceUpload, queueUpload, type Adapter } from '../src/publish/machine.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';
import { join } from 'node:path';
import { run } from '../src/util/proc.ts';

test('unlisted buffer + platform-reported region block hold the publish; clean video passes', async () => {
  const store = new Store(':memory:'); const { ids } = seed(store);
  const cfg = testConfig({ automation: { unlistedBufferMin: 10 } });
  const up = queueUpload(store, ids[0]!, 'youtube');
  let rs = { blockedRegions: [] as string[], allowedOnly: null as string[] | null, rejectionReason: null as string | null };
  const ad = { restrictions: async () => rs } as unknown as Adapter;
  const facts = { title: 't', description: 'd', tags: [], durationSec: 20, width: 1080, height: 1920 } as never;
  store.exec(`UPDATE uploads SET state='UNLISTED_VERIFIED', remote_id='abc', updated_at=datetime('now') WHERE id=?`, up);
  await assert.rejects(advanceUpload(store, cfg, ad, up, { facts, scheduledAt: new Date(Date.now() + 3600_000) }), /UNLISTED_BUFFER/);
  store.exec(`UPDATE uploads SET updated_at=datetime('now','-30 minutes') WHERE id=?`, up);
  rs = { blockedRegions: ['IN', 'US'], allowedOnly: null, rejectionReason: null };
  await assert.rejects(advanceUpload(store, cfg, ad, up, { facts, scheduledAt: new Date(Date.now() + 3600_000) }), /HELD_RESTRICTED: platform reports blocked in IN,US/);
  assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', up)!.state, 'UNLISTED_VERIFIED');
  rs = { blockedRegions: [], allowedOnly: null, rejectionReason: null };
  assert.equal(await advanceUpload(store, cfg, ad, up, { facts, scheduledAt: new Date(Date.now() + 3600_000) }), 'SCHEDULED_OR_APPROVED');
});

test('audio claim: real ffmpeg mutes only the claimed seconds and keeps duration', async () => {
  const d = tmpDir(); const src = join(d, 'a.mp4'); await makeFixture(src, 20);
  const dst = join(d, 'b.mp4'); const r = await run('ffmpeg', fixArgs(src, dst, 'audio', [{ from: 10, to: 14 }]));
  assert.equal(r.code, 0, r.stderr);
  const vol = async (s: number, t: number) => { const x = await run('ffmpeg', ['-ss', String(s), '-t', String(t), '-i', dst, '-af', 'volumedetect', '-f', 'null', '-']); return Number(/mean_volume: (-?[\d.]+|-inf)/.exec(x.stderr)?.[1] ?? 0); };
  assert.ok((await vol(10.5, 3)) < -60, 'claimed range silent'); assert.ok((await vol(5, 3)) > -40, 'rest untouched');
});

test('reliability score: claims lower it, clean clips raise it, <4 is high risk', () => {
  assert.equal(reliability(0, 0), 10); assert.equal(reliability(3, 3), 1); assert.equal(reliability(1, 11), 9); assert.ok(reliability(3, 3) < 4);
});

test('dynamic buffer, API failure holds (never publishes blind), block threshold', async () => {
  const store = new Store(':memory:'); const { ids } = seed(store);
  const up = queueUpload(store, ids[0]!, 'youtube');
  const mk = (over: Record<string, unknown> = {}) => testConfig({ automation: { unlistedBufferMin: 10, ...over } });
  const ok = { blockedRegions: [] as string[], allowedOnly: null, rejectionReason: null };
  let fn: () => Promise<typeof ok> = async () => ok; const ad = { restrictions: () => fn() } as unknown as Adapter;
  const facts = (d: number) => ({ title: 't', description: 'd', tags: [], duration: d, width: 1080, height: 1920 }) as never;
  const sched = { scheduledAt: new Date(Date.now() + 3600_000) };
  store.exec(`UPDATE uploads SET state='UNLISTED_VERIFIED', remote_id='abc', updated_at=datetime('now','-6 minutes') WHERE id=?`, up);
  assert.equal(await advanceUpload(store, mk(), ad, up, { facts: facts(20), ...sched }), 'SCHEDULED_OR_APPROVED'); // 20 s clip: 5 min buffer already over
  store.exec(`UPDATE uploads SET state='UNLISTED_VERIFIED', updated_at=datetime('now','-6 minutes') WHERE id=?`, up);
  await assert.rejects(advanceUpload(store, mk(), ad, up, { facts: facts(90), ...sched }), /UNLISTED_BUFFER/); // 90 s clip: 15 min
  store.exec(`UPDATE uploads SET updated_at=datetime('now','-30 minutes') WHERE id=?`, up);
  fn = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(advanceUpload(store, mk(), ad, up, { facts: facts(45), ...sched }), /NOT publishing blind/);
  fn = async () => ({ ...ok, blockedRegions: ['IN'] });
  await assert.rejects(advanceUpload(store, mk(), ad, up, { facts: facts(45), ...sched }), /HELD_RESTRICTED/);
  assert.equal(await advanceUpload(store, mk({ maxBlockedRegions: 2 }), ad, up, { facts: facts(45), ...sched }), 'SCHEDULED_OR_APPROVED');
});

test("kind 'both' makes two variants (muted + cut) from a real clip", async () => {
  const store = new Store(':memory:'); const { ids } = seed(store); const d = tmpDir(); const src = join(d, 'a.mp4'); await makeFixture(src, 20);
  store.exec('UPDATE clips SET edited_path=? WHERE id=?', src, ids[0]!);
  const r = await recordClaim(store, ids[0]!, { kind: 'both', ranges: [{ from: 8, to: 10 }] });
  assert.equal(store.all(`SELECT 1 FROM clips WHERE review='pending' AND output_id LIKE 'o0-fx%'`).length, 2); assert.match(r.note, /mute \+ cut/);
});
