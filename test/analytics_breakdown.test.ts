import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { createChannel } from '../src/channels.ts';
import { analyticsBreakdown } from '../src/analytics/collect.ts';

test('analytics are split per account, platform and video; a video without a snapshot is "unavailable", never zero', () => {
  const store = new Store(':memory:'); const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, authorized) VALUES (1,'local','r',1)`); store.exec(`INSERT INTO videos(id, source_id, path, fingerprint) VALUES (1,1,'/x','f')`);
  for (const i of [1, 2, 3]) { store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,1,0,6,.5,?)`, i, 'c' + i); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,1,?)`, i, i, 'o' + i, '/x', JSON.stringify({ title: 'V' + i })); }
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, channel_id, remote_id) VALUES (1,'youtube_shorts','PUBLISHED','k1',?, 'yt1')`, a.id);
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, channel_id, remote_id) VALUES (2,'youtube_shorts','PUBLISHED','k2',?, 'yt2')`, b.id);
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, channel_id, remote_id) VALUES (3,'facebook_reels','PUBLISHED','k3',?, 'fb3')`, a.id);
  store.exec(`INSERT INTO analytics_snapshots(platform, remote_id, views, likes, taken_at) VALUES ('youtube_shorts','yt1',100,5,'2026-11-19 01:00:00'),('youtube_shorts','yt1',150,7,'2026-11-19 02:00:00'),('youtube_shorts','yt2',40,1,'2026-11-19 02:00:00')`);
  const r = analyticsBreakdown(store);
  assert.equal(r.accounts.find((x) => x.account === a.slug && x.platform === 'youtube_shorts')!.views, 150, 'latest snapshot only'); assert.equal(r.accounts.find((x) => x.account === b.slug)!.views, 40);
  assert.equal(r.platforms.find((x) => x.platform === 'facebook_reels')!.unavailable, true); assert.equal(r.platforms.find((x) => x.platform === 'youtube_shorts')!.unavailable, false);
  const fb = r.videos.find((v) => v.clipId === 3)!; assert.equal(fb.available, false); assert.equal(fb.views, null);
});
