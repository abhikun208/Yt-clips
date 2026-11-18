import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { queueUpload, advanceUpload, DryRunAdapter, type ClipFacts } from '../src/publish/machine.ts';
import { normTitle } from '../src/publish/youtube.ts';
import { tmpDir } from './helpers.ts';

const facts: ClipFacts = { width: 1080, height: 1920, duration: 30, title: 'Mera Title', description: 'd', qcPass: true, authorized: true };
function seed() { const s = new Store(':memory:'); s.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,10,.5,'c')`); s.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1','/tmp/o1.mp4',1)`); return s; }
const cfg = () => loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { gates: { publishEnabled: true, publicVisibilityAllowed: true } } });

test('title comparison matches the way YouTube stores titles', () => { assert.equal(normTitle('  Mera   <Title> '), normTitle('Mera Title')); });
test('upload 19 case: video already PUBLIC on the platform at verify time → reconciled to PUBLISHED, not FAILED', async () => {
  const s = seed(); const c = cfg(); const ad = new DryRunAdapter(); const id = queueUpload(s, 1, 'youtube_shorts');
  for (const want of ['UPLOAD_PENDING', 'UPLOADING', 'UPLOAD_VERIFYING']) assert.equal(await advanceUpload(s, c, ad, id, { facts }), want);
  const remote = s.get<{ remote_id: string }>('SELECT remote_id FROM uploads WHERE id=?', id)!.remote_id; await ad.publish(remote); // owner/earlier call made it public
  const next = await advanceUpload(s, c, ad, id, { facts }); assert.equal(next, 'PUBLISHED'); assert.equal(s.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'PUBLISHED');
});
test('network outage is a pause, not a failure: state is kept and the same step resumes later', async () => {
  const s = seed(); const c = cfg(); const ad = new DryRunAdapter(); const id = queueUpload(s, 1, 'youtube_shorts'); for (let i = 0; i < 3; i++) await advanceUpload(s, c, ad, id, { facts }); // → UPLOAD_VERIFYING
  const real = ad.verify.bind(ad); let n = 0; ad.verify = async (...a: Parameters<typeof real>) => { if (n++ < 2) throw new Error('NETWORK_ERROR: network error: fetch failed (ENOTFOUND)'); return real(...a); };
  const before = s.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state;
  await assert.rejects(advanceUpload(s, c, ad, id, { facts }), /NETWORK_ERROR/); await assert.rejects(advanceUpload(s, c, ad, id, { facts }), /NETWORK_ERROR/);
  const mid = s.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state; assert.notEqual(mid, 'FAILED'); assert.ok(mid === before || mid === 'UPLOAD_VERIFYING', mid);
  assert.equal(await advanceUpload(s, c, ad, id, { facts }), 'UNLISTED_VERIFIED');
});
