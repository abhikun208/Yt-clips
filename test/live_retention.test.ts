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

test('dependency safety: shared chunk stays until ALL highlights are rendered+QC-passed; active jobs, failed renders, empty/QC-failed clips all keep the raw chunk', () => {
  const { cfg, st, mk, dataDir } = setup(); const good = join(dataDir, 'g.mp4'); writeFileSync(good, 'ok'); const empty = join(dataDir, 'e.mp4'); writeFileSync(empty, '');
  const clip = (id: number, cid: number, path: string, qc: number) => st.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (?,?,?,?,?)`, id, cid, `o${id}`, path, qc);
  const shared = mk(1, 'ANALYZED'); cand(st, 10, 1, 'rendered'); clip(10, 10, good, 1); cand(st, 11, 1, 'candidate'); // 2 highlights, only one rendered
  const emptyOut = mk(2, 'ANALYZED'); cand(st, 20, 2, 'rendered'); clip(20, 20, empty, 1);
  const qcFail = mk(3, 'ANALYZED'); cand(st, 30, 3, 'rendered'); clip(30, 30, good, 0);
  const jobbed = mk(4, 'ANALYZED'); st.exec(`INSERT INTO jobs(kind, key, state, run_after) VALUES ('analyze','analyze:4','RETRY',0)`);
  const renderJob = mk(5, 'ANALYZED'); cand(st, 50, 5, 'rendered'); clip(50, 50, good, 1); st.exec(`INSERT INTO jobs(kind, key, state, run_after) VALUES ('render','render:50','RUNNING',0)`);
  const rerender = mk(6, 'ANALYZED'); cand(st, 60, 6, 'rendered'); clip(60, 60, good, 1); st.exec(`INSERT INTO jobs(kind, key, state, run_after) VALUES ('rerender','rerender:60:123','PENDING',0)`);
  const failed = mk(7, 'FAILED'); // analysis failed: may be retried -> keep
  liveRetention(st, cfg);
  for (const [n, p] of Object.entries({ shared, emptyOut, qcFail, jobbed, renderJob, rerender, failed })) assert.equal(existsSync(p), true, `${n} must be kept`);
  // once the second highlight is rendered and verified the shared chunk goes
  const g2 = join(dataDir, 'g2.mp4'); writeFileSync(g2, 'ok'); st.exec(`UPDATE candidates SET status='rendered' WHERE id=11`); clip(11, 11, g2, 1);
  liveRetention(st, cfg); assert.equal(existsSync(shared), false, 'all dependents done -> deleted'); assert.equal(existsSync(good), true);
});

test('storage cap never deletes a chunk with selected highlights; it reports capExceeded instead (and age expiry spares them too)', () => {
  const { cfg, st, mk } = setup({ liveMaxBufferMB: 200 }); const big = 150 * 1024 * 1024;
  const needed = mk(1, 'ANALYZED', 1000, 20); cand(st, 10, 1, 'candidate'); const needed2 = mk(2, 'ANALYZED', 1000, 1); cand(st, 20, 2, 'candidate');
  st.exec(`UPDATE videos SET size=?`, big); const r = liveRetention(st, cfg);
  assert.equal(existsSync(needed), true); assert.equal(existsSync(needed2), true); assert.equal(r.capExceeded, true); assert.equal(r.dropped, 0);
  assert.equal(st.get<{ v: string }>(`SELECT v FROM kv WHERE k='live:capexceeded'`)!.v, '1');
});

test('a dead render never blocks storage forever: released after 4x the age limit with a warning, never earlier', () => {
  const { cfg, st, mk } = setup(); const early = mk(1, 'ANALYZED', 1000, 12); cand(st, 10, 1, 'candidate'); const late = mk(2, 'ANALYZED', 1000, 30); cand(st, 20, 2, 'candidate');
  const r = liveRetention(st, cfg); assert.equal(existsSync(early), true, '12h < 24h: kept'); assert.equal(existsSync(late), false, '30h > 24h: released'); assert.equal(r.stale, 1);
});
