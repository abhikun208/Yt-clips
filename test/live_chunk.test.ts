import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { testConfig } from './helpers.ts';
import { liveTick, _setSleep, type LiveDeps } from '../src/watcher/live-monitor.ts';
import { liveChunkGone } from '../src/pipeline.ts';

const setup = () => {
  const cfg = testConfig(); const store = new Store(cfg.dbPath);
  store.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES ('youtube_channel','https://www.youtube.com/@x/videos','x',1,'active',?)`, JSON.stringify({ watchLive: true }));
  return { cfg, store };
};
_setSleep(async () => undefined);
const kv = (s: Store, k: string) => s.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v;

test('chunk metadata (source, stream id, seq, times, bytes) is recorded; stream id tracked', async () => {
  const { cfg, store } = setup(); let rec = 0, probes = 0;
  const deps: LiveDeps = {
    now: () => Date.now() + 2e10, probe: async () => (++probes === 1 ? { live: true, reason: 'live', id: 'abc123' } : { live: false, reason: 'off' }),
    record: async (_u, out) => { if (++rec > 1) return { ok: false, reason: 'eof' }; writeFileSync(out, Buffer.alloc(300_000)); return { ok: true, reason: 'ok' }; },
    ingest: async () => 501,
  };
  await liveTick(store, cfg, deps, { awaitCaptures: true });
  const m = JSON.parse(kv(store, 'live:chunk:501')!);
  assert.equal(m.stream, 'abc123'); assert.equal(m.seq, 1); assert.equal(m.bytes, 300_000); assert.ok(m.startedAt && m.endedAt);
  assert.equal(kv(store, 'live:stream:1'), 'abc123');
});

test('storage cap full: no new capture is started, nothing recorded', async () => {
  const { cfg, store } = setup(); let rec = 0;
  store.exec(`INSERT INTO kv(k,v) VALUES ('live:capexceeded','1')`);
  const deps: LiveDeps = { now: () => Date.now() + 3e10, probe: async () => ({ live: true, reason: 'live' }), record: async () => { rec++; return { ok: false, reason: 'x' }; }, ingest: async () => null };
  const r = await liveTick(store, cfg, deps, { awaitCaptures: true });
  assert.equal(r.started, 0); assert.equal(rec, 0); assert.equal(r.skipped.cap_exceeded, 1);
});

test('liveChunkGone: exact error for a discarded chunk, null for normal/intact videos', () => {
  const { store } = setup();
  store.exec(`INSERT INTO videos(id, path, fingerprint, state) VALUES (7,'/nonexistent/x.mp4','fp7','NEW')`);
  assert.equal(liveChunkGone(store, 7), null, 'not a live chunk');
  store.exec(`INSERT INTO kv(k,v) VALUES ('live:video:7','1')`);
  assert.match(liveChunkGone(store, 7)!, /live chunk missing: video 7 file \/nonexistent\/x\.mp4/);
  store.exec(`INSERT INTO kv(k,v) VALUES ('live:discarded:7','expired@t')`);
  assert.match(liveChunkGone(store, 7)!, /expired@t/);
});
