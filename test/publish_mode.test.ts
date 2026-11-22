import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig, publishMode, assertPublishAllowed } from '../src/config.ts';
import { queueUpload, advanceUpload, DryRunAdapter, type ClipFacts } from '../src/publish/machine.ts';
import { tmpDir } from './helpers.ts';

const gates = (g: object) => loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { gates: g } });
const facts: ClipFacts = { width: 1080, height: 1920, duration: 30, title: 't', description: 'd', qcPass: true, authorized: true };
function seed() { const s = new Store(':memory:'); s.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); s.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,10,.5,'c')`); s.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1','/tmp/o1.mp4',1)`); return s; }

test('PUBLISH_MODE: unset / empty / unknown value = DRY_RUN; PRIVATE and PUBLIC recognised case-insensitively', () => {
  for (const v of [undefined, '', 'maybe', 'public!', 'true']) assert.equal(publishMode({ PUBLISH_MODE: v }), 'DRY_RUN', String(v));
  assert.equal(publishMode({}), 'DRY_RUN'); assert.equal(publishMode({ PUBLISH_MODE: ' private ' }), 'PRIVATE'); assert.equal(publishMode({ PUBLISH_MODE: 'Public' }), 'PUBLIC');
});
test('assertPublishAllowed: DRY_RUN blocks everything, PRIVATE blocks public only, PUBLIC still needs its own gate; gates OFF always block', () => {
  const on = gates({ publishEnabled: true }); const onPub = gates({ publishEnabled: true, publicVisibilityAllowed: true }); const off = gates({});
  for (const vis of ['private', 'unlisted', 'public'] as const) assert.throws(() => assertPublishAllowed(onPub, vis, { PUBLISH_MODE: 'DRY_RUN' }), /^Error: PUBLISH_DISABLED.*DRY_RUN/, vis);
  assert.doesNotThrow(() => assertPublishAllowed(on, 'unlisted', { PUBLISH_MODE: 'PRIVATE' })); assert.doesNotThrow(() => assertPublishAllowed(on, 'private', { PUBLISH_MODE: 'PRIVATE' }));
  assert.throws(() => assertPublishAllowed(onPub, 'public', { PUBLISH_MODE: 'PRIVATE' }), /PUBLIC_DISABLED.*PRIVATE/, 'PRIVATE never publishes publicly even with the gate on');
  assert.throws(() => assertPublishAllowed(on, 'public', { PUBLISH_MODE: 'PUBLIC' }), /PUBLIC_DISABLED.*publicVisibilityAllowed/, 'PUBLIC mode still needs the separate gate');
  assert.doesNotThrow(() => assertPublishAllowed(onPub, 'public', { PUBLISH_MODE: 'PUBLIC' }));
  for (const m of ['DRY_RUN', 'PRIVATE', 'PUBLIC']) assert.throws(() => assertPublishAllowed(off, 'unlisted', { PUBLISH_MODE: m }), /PUBLISH_DISABLED: gates\.publishEnabled/, m);
});
test('state machine honours the mode: gates ON but DRY_RUN => held at UPLOAD_PENDING, zero adapter calls, not marked FAILED; PRIVATE => reaches UNLISTED_VERIFIED, then public stays blocked', async () => {
  const keep = process.env.PUBLISH_MODE; try {
    const cfg = gates({ publishEnabled: true, publicVisibilityAllowed: true });
    process.env.PUBLISH_MODE = 'DRY_RUN'; { const s = seed(); const ad = new DryRunAdapter(); const id = queueUpload(s, 1, 'youtube_shorts');
      assert.equal(await advanceUpload(s, cfg, ad, id, { facts }), 'UPLOAD_PENDING'); await assert.rejects(advanceUpload(s, cfg, ad, id, { facts }), /PUBLISH_DISABLED/);
      assert.equal(ad.calls.length, 0); assert.equal(s.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id)!.state, 'UPLOAD_PENDING'); }
    process.env.PUBLISH_MODE = 'PRIVATE'; { const s = seed(); const ad = new DryRunAdapter(); const id = queueUpload(s, 1, 'youtube_shorts'); const seen: string[] = [];
      for (let i = 0; i < 4; i++) seen.push(await advanceUpload(s, cfg, ad, id, { facts })); assert.deepEqual(seen, ['UPLOAD_PENDING', 'UPLOADING', 'UPLOAD_VERIFYING', 'UNLISTED_VERIFIED']);
      assert.equal(s.get<{ visibility: string }>('SELECT visibility FROM uploads WHERE id=?', id)!.visibility, 'unlisted'); }
  } finally { if (keep === undefined) delete process.env.PUBLISH_MODE; else process.env.PUBLISH_MODE = keep; }
});
