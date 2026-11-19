import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { createChannel } from '../src/channels.ts';
import { listDistributions, statusOf } from '../src/publish/distribution.ts';

test('statusOf: SUCCESS / PARTIAL_SUCCESS / BLOCKED / RETRY / FAILED / IN_PROGRESS', () => {
  const j = (state: string, error: string | null = null) => ({ state, error });
  assert.equal(statusOf([j('PUBLISHED'), j('PUBLISHED')]), 'SUCCESS');
  assert.equal(statusOf([j('PUBLISHED'), j('UPLOADING', 'AUTH_REVOKED: x')]), 'PARTIAL_SUCCESS');
  assert.equal(statusOf([j('PUBLISHED'), j('FAILED', 'boom')]), 'PARTIAL_SUCCESS');
  assert.equal(statusOf([j('UPLOAD_PENDING', 'AUTH_IDENTITY_MISMATCH: x'), j('UPLOAD_PENDING', 'DESTINATION_DISABLED: y')]), 'BLOCKED');
  assert.equal(statusOf([j('FAILED', 'e'), j('UPLOADING')]), 'RETRY');
  assert.equal(statusOf([j('FAILED', 'e'), j('QC_FAILED', 'e')]), 'FAILED');
  assert.equal(statusOf([j('QC_PASSED'), j('UPLOADING')]), 'IN_PROGRESS');
});

test('listDistributions groups independent destination jobs per clip; one blocked destination does not hide the finished one', () => {
  const store = new Store(':memory:'); const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r',?,1)`, a.id); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f')`);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (1,1,'o1','/x.mp4',1,?)`, JSON.stringify({ title: 'T one' }));
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, channel_id) VALUES (1,'youtube_shorts','PUBLISHED','k1',?)`, a.id);
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, channel_id, error) VALUES (1,'youtube_shorts','UPLOAD_PENDING','k2@ch',?, 'AUTH_REVOKED: reconnect')`, b.id);
  const d = listDistributions(store); assert.equal(d.length, 1); assert.equal(d[0]!.status, 'PARTIAL_SUCCESS'); assert.equal(d[0]!.done, 1); assert.equal(d[0]!.total, 2); assert.deepEqual(d[0]!.jobs.map((x) => x.channelSlug), [a.slug, b.slug]);
});
