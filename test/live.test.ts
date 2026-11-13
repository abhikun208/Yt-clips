import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { testConfig } from './helpers.ts';
import { liveTick, liveUrl, liveBudget, _setSleep, type LiveDeps } from '../src/watcher/live-monitor.ts';

const setup = () => {
  const cfg = testConfig(); const store = new Store(cfg.dbPath);
  store.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES ('youtube_channel','https://www.youtube.com/@x/videos','x',1,'active',?)`, JSON.stringify({ watchLive: true }));
  return { cfg, store };
};
_setSleep(async () => undefined);

test('liveUrl maps a channel videos URL to /live', () => { assert.equal(liveUrl('https://www.youtube.com/@x/videos'), 'https://www.youtube.com/@x/live'); });

test('live source: chunks are recorded until the stream ends, each ingested + tagged, temp cleaned', async () => {
  const { cfg, store } = setup(); let probes = 0, rec = 0; const ingested: string[] = [];
  const deps: LiveDeps = {
    now: () => Date.now(),
    probe: async () => { probes++; return probes <= 3 ? { live: true, reason: 'live' } : { live: false, reason: 'off' }; }, // initial tick + 2 loop checks live, then ended
    record: async (_u, out) => { rec++; writeFileSync(out, Buffer.alloc(300_000)); return { ok: true, reason: 'ok' }; },
    ingest: async (f, title) => { ingested.push(title); assert.ok(existsSync(f)); return 100 + ingested.length; },
  };
  const r = await liveTick(store, cfg, deps, { awaitCaptures: true });
  assert.equal(r.started, 1); assert.equal(rec, 2); assert.equal(ingested.length, 2); assert.match(ingested[0], /^\[LIVE\]/);
  assert.equal(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='live:video:101'`)?.v, '1');
  assert.deepEqual(readdirSync(cfg.dirs.tmp).filter((f) => f.startsWith('live_')), []); // cleanup after the stream ended
});

test('offline source: nothing recorded, reason counted (no silent skip)', async () => {
  const { cfg, store } = setup(); let rec = 0;
  const deps: LiveDeps = { now: () => Date.now() + 1e9, probe: async () => ({ live: false, reason: 'off' }), record: async () => { rec++; return { ok: false, reason: 'x' }; }, ingest: async () => null };
  const r = await liveTick(store, cfg, deps, { awaitCaptures: true });
  assert.equal(rec, 0); assert.equal(r.started, 0); assert.equal(r.skipped.offline, 1);
});

test('internet drop mid-stream: failed chunk is discarded and retried, stream continues afterwards', async () => {
  const { cfg, store } = setup(); let n = 0, probes = 0; const got: number[] = [];
  const deps: LiveDeps = {
    now: () => Date.now() + 5e9, probe: async () => { probes++; return probes <= 3 ? { live: true, reason: 'live' } : { live: false, reason: 'off' }; },
    record: async (_u, out) => { n++; if (n === 1) return { ok: false, reason: 'net down' }; writeFileSync(out, Buffer.alloc(300_000)); return { ok: true, reason: 'ok' }; },
    ingest: async () => { got.push(1); return 7; },
  };
  await liveTick(store, cfg, deps, { awaitCaptures: true });
  assert.equal(got.length, 1); // chunk 1 dropped, chunk 2 ingested
});

test('only watchLive sources are polled', async () => {
  const { cfg, store } = setup(); store.exec(`UPDATE sources SET meta_json='{}'`); let probes = 0;
  const r = await liveTick(store, cfg, { now: () => Date.now(), probe: async () => { probes++; return { live: true, reason: '' }; }, record: async () => ({ ok: false, reason: '' }), ingest: async () => null }, { awaitCaptures: true });
  assert.equal(probes, 0); assert.equal(r.checked, 0);
});

test('liveBudget: max 2 live-captured uploads per hour', () => {
  const { cfg, store } = setup();
  assert.equal(liveBudget(store, cfg), 2);
  store.exec(`INSERT INTO videos(source_id, path, fingerprint, size, duration, width, height, fps, has_audio, state) VALUES (1,'/p','f',1,60,1920,1080,30,1,'NEW')`);
  const vid = store.get<{ id: number }>('SELECT id FROM videos')!.id; store.exec(`INSERT INTO kv(k,v) VALUES (?, '1')`, `live:video:${vid}`);
  store.exec(`INSERT INTO candidates(video_id, start_sec, end_sec, score, fingerprint, status) VALUES (?,0,30,0.9,'cf','rendered')`, vid);
  const cand = store.get<{ id: number }>('SELECT id FROM candidates')!.id;
  for (const i of [1, 2]) { store.exec(`INSERT INTO clips(candidate_id, output_id, edited_path, qc_pass) VALUES (?,?,?,1)`, cand, `o${i}`, '/e'); const cid = store.get<{ id: number }>('SELECT id FROM clips WHERE output_id=?', `o${i}`)!.id; store.exec(`INSERT INTO uploads(clip_id, platform, idempotency_key) VALUES (?,?,?)`, cid, 'youtube_shorts', `k${i}`); }
  assert.equal(liveBudget(store, cfg), 0);
});
