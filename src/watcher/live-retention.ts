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
export interface RetentionResult { discarded: number; freedBytes: number; keptBytes: number; dropped: number }

function discard(store: Store, v: { id: number; path: string }, why: string): number {
  let freed = 0;
  for (const p of [v.path, ...SIDE.map((e) => v.path.replace(/\.[^.]+$/, '') + e)]) { try { if (existsSync(p)) { freed += statSync(p).size; rmSync(p, { force: true }); } } catch { /* best effort */ } }
  store.exec(`INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `live:discarded:${v.id}`, `${why}@${new Date().toISOString()}`);
  return freed;
}

export function liveRetention(store: Store, cfg: Config, now = Date.now()): RetentionResult {
  const lim = liveLimits(cfg); const res: RetentionResult = { discarded: 0, freedBytes: 0, keptBytes: 0, dropped: 0 };
  const rows = store.all<{ id: number; path: string; state: string; created_at: string; size: number | null }>(
    `SELECT v.id, v.path, v.state, v.created_at, v.size FROM videos v WHERE EXISTS (SELECT 1 FROM kv WHERE k='live:video:' || v.id) AND NOT EXISTS (SELECT 1 FROM kv WHERE k='live:discarded:' || v.id) ORDER BY v.id`);
  const keep: { id: number; path: string; size: number; analysed: boolean }[] = [];
  for (const v of rows) {
    const age = now - Date.parse(v.created_at.replace(' ', 'T') + 'Z');
    if (!existsSync(v.path)) { store.exec(`INSERT OR IGNORE INTO kv(k, v) VALUES (?, 'missing')`, `live:discarded:${v.id}`); continue; }
    const pending = store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM candidates c WHERE c.video_id=? AND c.status='candidate' AND NOT EXISTS (SELECT 1 FROM clips k WHERE k.candidate_id=c.id AND k.edited_path IS NOT NULL)`, v.id)!.n;
    const unrendered = store.all<{ edited_path: string | null }>(`SELECT k.edited_path FROM candidates c JOIN clips k ON k.candidate_id=c.id WHERE c.video_id=? AND c.status IN ('rendered','candidate')`, v.id).some((k) => !k.edited_path || !existsSync(k.edited_path));
    const analysed = v.state === 'ANALYZED' || v.state === 'FAILED' || v.state === 'PARKED';
    const done = analysed && pending === 0 && !unrendered;
    const old = age > lim.retainHours * 3_600_000;
    if (done || (old && pending === 0)) { res.freedBytes += discard(store, v, done ? 'extracted' : 'expired'); res.discarded++; continue; }
    keep.push({ id: v.id, path: v.path, size: v.size ?? statSync(v.path).size, analysed });
  }
  let total = keep.reduce((a, b) => a + b.size, 0); const cap = lim.maxBufferMB * 1024 * 1024;
  // over the cap: drop the OLDEST chunks first (a stale live moment is worth less than a fresh one); say so loudly
  for (const k of keep) {
    if (total <= cap) break;
    warn('live buffer cap: oldest chunk dropped', { video: k.id, bytes: k.size, capMB: lim.maxBufferMB });
    store.exec(`UPDATE videos SET state='PARKED', updated_at=datetime('now') WHERE id=? AND state IN ('NEW','ANALYZING')`, k.id);
    store.exec(`UPDATE jobs SET state='DONE' WHERE key=? AND state IN ('PENDING','RETRY')`, `analyze:${k.id}`);
    res.freedBytes += discard(store, k, 'cap'); total -= k.size; res.dropped++; res.discarded++;
  }
  res.keptBytes = total;
  if (res.discarded) info('live retention', { ...res });
  return res;
}
