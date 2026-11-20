import { existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { liveLimits } from './live-monitor.ts';
import { info, warn } from '../util/log.ts';

/**
 * Rolling buffer for live captures: the raw 5-min chunks are TEMPORARY. A chunk is kept only while it is still needed:
 *   - not analysed yet                       -> kept (bounded by the size cap below)
 *   - analysed, a selected candidate still has to be rendered -> kept
 *   - every selected candidate is rendered (clip file exists) or none was selected -> raw chunk deleted (sidecars too)
 * Hard limits: total raw live bytes <= liveMaxBufferMB (oldest unneeded first, then oldest unanalysed), and anything older than liveRetainHours is dropped.
 * The DB rows, clips and edited outputs are never touched; a discarded chunk is flagged kv `live:discarded:<id>` and is never re-queued.
 */
const SIDE = ['.srt', '.vtt', '.json', '.json.src', '.edited.json', '.live_chat.json', '.chat.json', '.heatmap.json', '.wav'];
/** Crash recovery: a capture that died with the process leaves half-written chunks in tmp/live_<id>/ - they can never be completed, so remove them at boot. */
export function cleanLiveTemp(cfg: Config): number {
  let n = 0;
  try { for (const d of readdirSync(cfg.dirs.tmp)) if (/^live_\d+$/.test(d)) { rmSync(join(cfg.dirs.tmp, d), { recursive: true, force: true }); n++; } } catch { /* no tmp dir yet */ }
  return n;
}
export interface RetentionResult { discarded: number; freedBytes: number; keptBytes: number; dropped: number; protectedBytes: number; capExceeded: boolean; stale: number }

function discard(store: Store, v: { id: number; path: string }, why: string): number {
  let freed = 0;
  for (const p of [v.path, ...SIDE.map((e) => v.path.replace(/\.[^.]+$/, '') + e)]) { try { if (existsSync(p)) { freed += statSync(p).size; rmSync(p, { force: true }); } } catch { /* best effort */ } }
  store.exec(`INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `live:discarded:${v.id}`, `${why}@${new Date().toISOString()}`);
  return freed;
}

/** Why a raw chunk may NOT be deleted yet (empty = nothing depends on it). Every selected highlight of the chunk must have a rendered, QC-passed, non-empty clip file, and no job may still need the chunk. */
export function chunkDependencies(store: Store, v: { id: number; state: string }): string[] {
  const why: string[] = [];
  if (v.state !== 'ANALYZED') why.push(`analysis not finished (${v.state})`);
  const cands = store.all<{ id: number; status: string }>(`SELECT id, status FROM candidates WHERE video_id=? AND status IN ('candidate','rendered')`, v.id);
  for (const c of cands) {
    const clips = store.all<{ id: number; edited_path: string | null; qc_pass: number | null }>('SELECT id, edited_path, qc_pass FROM clips WHERE candidate_id=?', c.id);
    if (!clips.length) { why.push(`selected highlight #${c.id} not rendered yet`); continue; }
    for (const k of clips) {
      let size = 0; try { size = k.edited_path && existsSync(k.edited_path) ? statSync(k.edited_path).size : 0; } catch { size = 0; }
      if (!size) why.push(`clip #${k.id} output file missing/empty`); else if (k.qc_pass !== 1) why.push(`clip #${k.id} not QC-passed`);
    }
  }
  const active = store.all<{ key: string }>(`SELECT key FROM jobs WHERE state IN ('PENDING','RETRY','RUNNING') AND (key = ? OR key IN (SELECT 'render:' || id FROM candidates WHERE video_id=?))`, `analyze:${v.id}`, v.id);
  for (const a of active) why.push(`job ${a.key} still active`);
  for (const k of store.all<{ id: number }>(`SELECT k.id FROM clips k JOIN candidates c ON c.id=k.candidate_id WHERE c.video_id=?`, v.id))
    if (store.get(`SELECT 1 FROM jobs WHERE state IN ('PENDING','RETRY','RUNNING') AND key LIKE ?`, `rerender:${k.id}:%`)) why.push(`rerender of clip #${k.id} active`);
  return why;
}

export function liveRetention(store: Store, cfg: Config, now = Date.now()): RetentionResult {
  const lim = liveLimits(cfg); const res: RetentionResult = { discarded: 0, freedBytes: 0, keptBytes: 0, dropped: 0, protectedBytes: 0, capExceeded: false, stale: 0 };
  const rows = store.all<{ id: number; path: string; state: string; created_at: string; size: number | null }>(
    `SELECT v.id, v.path, v.state, v.created_at, v.size FROM videos v WHERE EXISTS (SELECT 1 FROM kv WHERE k='live:video:' || v.id) AND NOT EXISTS (SELECT 1 FROM kv WHERE k='live:discarded:' || v.id) ORDER BY v.id`);
  const keep: { id: number; path: string; size: number; deps: string[] }[] = [];
  for (const v of rows) {
    const age = now - Date.parse(v.created_at.replace(' ', 'T') + 'Z');
    if (!existsSync(v.path)) { // a required chunk is gone: say exactly which one, never pretend
      const deps = chunkDependencies(store, v).filter((d) => !/analysis not finished/.test(d));
      if (deps.length || v.state !== 'ANALYZED') warn('live chunk file missing while still needed', { video: v.id, path: v.path, needed_by: deps.join('; ') || v.state });
      store.exec(`INSERT OR IGNORE INTO kv(k, v) VALUES (?, ?)`, `live:discarded:${v.id}`, `missing@${new Date(now).toISOString()}`); continue;
    }
    const size = v.size ?? statSync(v.path).size; const deps = chunkDependencies(store, v);
    if (!deps.length) { res.freedBytes += discard(store, v, 'extracted'); res.discarded++; continue; } // ALL highlights rendered + QC-passed + file verified, no job needs it
    const staleAfter = lim.retainHours * 4 * 3_600_000; // a dependency that never completes (dead render) is released after 4x the age limit - loudly, with the reason
    if (age > staleAfter && !deps.some((d) => /still active/.test(d))) { warn('live chunk released after age limit although highlights were never rendered', { video: v.id, hours: Math.round(age / 3_600_000), deps: deps.join('; ') }); res.freedBytes += discard(store, v, 'stale-unrendered'); res.discarded++; res.stale++; continue; }
    const unprotected = deps.every((d) => /^analysis not finished/.test(d)) && v.state !== 'ANALYZING' && !store.get(`SELECT 1 FROM jobs WHERE key=? AND state IN ('PENDING','RETRY','RUNNING')`, `analyze:${v.id}`);
    if (unprotected && age > lim.retainHours * 3_600_000) { res.freedBytes += discard(store, v, 'expired'); res.discarded++; continue; } // never analysed, no job, too old
    keep.push({ id: v.id, path: v.path, size, deps });
  }
  let total = keep.reduce((a, b) => a + b.size, 0); const cap = lim.maxBufferMB * 1024 * 1024;
  // over the cap: only chunks that NOTHING depends on (never analysed and no job queued - i.e. orphans) may go, oldest first. Chunks with selected highlights / active jobs are PROTECTED.
  for (const k of keep) {
    if (total <= cap) break;
    if (k.deps.some((d) => !/^analysis not finished/.test(d)) || store.get(`SELECT 1 FROM jobs WHERE key=? AND state IN ('PENDING','RETRY','RUNNING')`, `analyze:${k.id}`) || store.get(`SELECT 1 FROM videos WHERE id=? AND state='ANALYZING'`, k.id)) continue;
    warn('live buffer cap: unanalysed orphan chunk dropped', { video: k.id, bytes: k.size, capMB: lim.maxBufferMB });
    res.freedBytes += discard(store, k, 'cap'); total -= k.size; res.dropped++; res.discarded++; k.size = 0;
  }
  res.protectedBytes = keep.filter((k) => k.size > 0).reduce((a, b) => a + b.size, 0); res.keptBytes = total; res.capExceeded = total > cap;
  if (res.capExceeded) warn('live buffer over cap but every remaining chunk is still needed - nothing deleted, capture will back off', { keptMB: Math.round(total / 1048576), capMB: lim.maxBufferMB });
  store.exec(`INSERT INTO kv(k, v) VALUES ('live:capexceeded', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, res.capExceeded ? '1' : '0');
  if (res.discarded) info('live retention', { ...res });
  return res;
}
