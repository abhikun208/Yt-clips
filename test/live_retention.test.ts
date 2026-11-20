import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { liveRetention } from '../src/watcher/live-retention.ts';
import { tmpDir } from './helpers.ts';

function setup(over: Record<string, unknown> = {}) {
  const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir, overrides: { automation: over } as never }); const st = new Store(cfg.dbPath);
  st.exec(`INSERT INTO sources(id, kind, uri, authorized) VALUES (1,'youtube_channel','u',1)`);
  const mk = (id: number, state: string, bytes = 1000, ageH = 0) => { const p = join(dataDir, `chunk${id}.mp4`); writeFileSync(p, Buffer.alloc(bytes)); writeFileSync(p.replace('.mp4', '.srt'), 'x');
    st.exec(`INSERT INTO videos(id, source_id, path, fingerprint, size, state, created_at) VALUES (?,1,?,?,?,?, datetime('now', ?))`, id, p, `f${id}`, bytes, state, `-${ageH} hours`); st.exec(`INSERT INTO kv(k,v) VALUES (?, '1')`, `live:video:${id}`); return p; };
  return { cfg, st, mk, dataDir };
}
const cand = (st: Store, id: number, vid: number, status: string) => st.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint, status) VALUES (?,?,0,6,.5,?,?)`, id, vid, `c${id}`, status);

test('rolling buffer: raw chunk is deleted only after its selected highlights are rendered; unneeded chunks vanish, needed ones stay', () => {
  const { cfg, st, mk, dataDir } = setup();
  const noHi = mk(1, 'ANALYZED');                       // analysed, nothing selected -> discard
  const waiting = mk(2, 'ANALYZED'); cand(st, 20, 2, 'candidate'); // selected but not rendered yet -> keep
  const clipFile = join(dataDir, 'clip3.mp4'); writeFileSync(clipFile, 'c');
  const rendered = mk(3, 'ANALYZED'); cand(st, 30, 3, 'rendered'); st.exec(`INSERT INTO clips(candidate_id, output_id, edited_path, qc_pass) VALUES (30,'o3',?,1)`, clipFile); // extracted -> discard
  const fresh = mk(4, 'NEW');                           // not analysed yet -> keep
  const r = liveRetention(st, cfg);
  assert.equal(existsSync(noHi), false); assert.equal(existsSync(rendered), false); assert.equal(existsSync(waiting), true); assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(noHi.replace('.mp4', '.srt')), false, 'sidecars go too'); assert.equal(existsSync(clipFile), true, 'the finished clip is never touched');
  assert.equal(r.discarded, 2); assert.ok(st.get('SELECT 1 FROM kv WHERE k=?', 'live:discarded:3')); assert.ok(st.get('SELECT 1 FROM videos WHERE id=3'), 'DB rows are preserved');
  assert.equal(liveRetention(st, cfg).discarded, 0, 'idempotent');
});

test('rolling buffer: size cap drops the OLDEST chunks, age limit drops stale chunks without highlights', () => {
  const { cfg, st, mk } = setup({ liveMaxBufferMB: 200 });
  const big = 120 * 1024 * 1024; // sparse-ish: Buffer.alloc of 120MB x3 is heavy, so fake sizes in the DB instead
  const a = mk(1, 'NEW'); const b = mk(2, 'NEW'); const c = mk(3, 'NEW');
  st.exec(`UPDATE videos SET size=?`, big);
  const r = liveRetention(st, cfg);
  assert.equal(r.dropped, 2); assert.equal(existsSync(a), false); assert.equal(existsSync(b), false); assert.equal(existsSync(c), true, 'newest survives (360MB > 200MB cap -> two oldest dropped)');
  const o = setup(); const old = o.mk(5, 'NEW', 1000, 8); const young = o.mk(6, 'NEW', 1000, 1);
  liveRetention(o.st, o.cfg); assert.equal(existsSync(old), false, '8h old unneeded chunk expired'); assert.equal(existsSync(young), true);
});

test('crash recovery: partial chunks of a dead capture are removed at boot, finished library files are not', async () => {
  const { cfg } = setup(); const { mkdirSync } = await import('node:fs'); const { cleanLiveTemp } = await import('../src/watcher/live-retention.ts');
  mkdirSync(join(cfg.dirs.tmp, 'live_7'), { recursive: true }); writeFileSync(join(cfg.dirs.tmp, 'live_7', 'a.mp4'), 'partial'); mkdirSync(join(cfg.dirs.tmp, 'other'), { recursive: true });
  assert.equal(cleanLiveTemp(cfg), 1); assert.equal(existsSync(join(cfg.dirs.tmp, 'live_7')), false); assert.equal(existsSync(join(cfg.dirs.tmp, 'other')), true);
});
