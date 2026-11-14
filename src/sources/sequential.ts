import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { info } from '../util/log.ts';

/**
 * STRICT SEQUENTIAL LOCK: one active video per watched channel. A channel is BUSY while a video it downloaded still has unfinished
 * analyze / render / metadata work (jobs PENDING, RETRY or RUNNING). Only then is the next video of that channel downloaded. Other channels are unaffected
 * (the poller simply moves on to the next idle channel). Finished clips waiting for review/upload do NOT keep a channel busy (that could be days).
 * A job that has not moved for 6 h is ignored, so one stuck job can never freeze a channel forever.
 */
export interface Busy { busy: boolean; reason: string; videoId?: number }
const ACTIVE = `('PENDING','RETRY','RUNNING')`;
export function channelBusy(store: Store, channelSourceId: number, maxActive = 1): Busy {
  const vids = store.all<{ id: number; state: string; age: number }>(`SELECT v.id, v.state, (julianday('now') - julianday(v.created_at)) * 24 AS age FROM videos v JOIN sources s ON s.id=v.source_id WHERE json_extract(COALESCE(s.meta_json,'{}'),'$.channelSource')=? ORDER BY v.id DESC LIMIT 50`, channelSourceId);
  let active = 0; let last: Busy = { busy: false, reason: 'idle' };
  for (const v of vids) {
    const job = store.get<{ kind: string; n: number }>(`SELECT j.kind, COUNT(*) n FROM jobs j WHERE j.state IN ${ACTIVE} AND j.updated_at > datetime('now','-6 hours') AND (
        j.key = 'analyze:' || ?1
        OR (j.kind='render' AND j.key IN (SELECT 'render:' || id FROM candidates WHERE video_id=?1))
        OR (j.kind IN ('meta','rerender') AND j.key IN (SELECT 'meta:' || k.id FROM clips k JOIN candidates c ON c.id=k.candidate_id WHERE c.video_id=?1)))`, v.id);
    if (job && job.n > 0) { active++; last = { busy: true, reason: `video #${v.id}: ${job.kind} kaam chal raha/baaki hai (${active}/${maxActive})`, videoId: v.id }; continue; }
    if ((v.state === 'NEW' || v.state === 'ANALYZING') && v.age < 6 && !store.get(`SELECT 1 FROM jobs WHERE key='analyze:'||? AND state IN ('DEAD','DONE','CANCELLED')`, v.id)) { active++; last = { busy: true, reason: `video #${v.id}: analyze shuru hone wala hai (${active}/${maxActive})`, videoId: v.id }; }
  }
  return active >= Math.max(1, maxActive) ? last : { busy: false, reason: active ? `${active}/${maxActive} active` : 'idle' };
}
export const lockOn = (cfg: Config): boolean => cfg.automation.sequentialLock !== false;

/**
 * Optional storage saver (storage.freeAfterRender, default OFF): as soon as the LAST clip of a video is rendered (no analyze/render/meta job left,
 * every candidate has its clip) our copy of the source file is deleted. Finished shorts stay. Trade-off: later re-render / re-analyze of that video
 * is impossible (ensureLocal() then says so). Never deletes a file outside our own sources folder.
 */
export function maybeFreeSource(store: Store, cfg: Config, videoId: number): { freed: boolean; mb: number; why: string } {
  if (!cfg.storage.freeAfterRender) return { freed: false, mb: 0, why: 'off' };
  const v = store.get<{ id: number; path: string; state: string }>('SELECT id, path, state FROM videos WHERE id=?', videoId); if (!v) return { freed: false, mb: 0, why: 'unknown video' };
  const left = store.get<{ n: number }>(`SELECT COUNT(*) n FROM jobs j WHERE j.state IN ${ACTIVE} AND (j.key='analyze:'||?1 OR (j.kind='render' AND j.key IN (SELECT 'render:'||id FROM candidates WHERE video_id=?1)) OR (j.kind IN ('meta','rerender') AND j.key IN (SELECT 'meta:'||k.id FROM clips k JOIN candidates c ON c.id=k.candidate_id WHERE c.video_id=?1)))`, videoId)?.n ?? 1;
  if (left) return { freed: false, mb: 0, why: 'jobs baaki' };
  const unrendered = store.get<{ n: number }>(`SELECT COUNT(*) n FROM candidates c WHERE c.video_id=? AND c.status='candidate' AND NOT EXISTS (SELECT 1 FROM clips k WHERE k.candidate_id=c.id)`, videoId)?.n ?? 1;
  const clips = store.get<{ n: number }>(`SELECT COUNT(*) n FROM clips k JOIN candidates c ON c.id=k.candidate_id WHERE c.video_id=?`, videoId)?.n ?? 0;
  if (unrendered || !clips) return { freed: false, mb: 0, why: unrendered ? 'candidates baaki' : 'koi clip nahi' };
  if (!resolve(v.path).startsWith(resolve(cfg.dirs.sources) + sep)) return { freed: false, mb: 0, why: 'file hamare sources folder me nahi (owner ka original)' };
  if (!existsSync(v.path)) return { freed: false, mb: 0, why: 'file pehle se nahi' };
  const mb = statSync(v.path).size / 1048576; rmSync(v.path, { force: true });
  store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `local:pruned:${videoId}`, new Date().toISOString());
  info('source file deleted after last clip render', { video: videoId, freedMb: Math.round(mb) }); return { freed: true, mb: Math.round(mb), why: 'ok' };
}

/**
 * SMART CLEANUP (storage.autoCleanup): delete our copy of a YouTube-downloaded source once the video is DONE: nothing left to analyze/render, every candidate has its clip and every
 * clip is finished (published, QC-failed or parked), or - when a clip sits in review - nothing happened for `storage.sourceKeepDays` (7). Re-render/re-analyze later re-downloads it
 * automatically (refetchSource). Uploaded local files are never touched (they cannot be re-fetched). Runs every automation cycle; any error is logged and skipped (never breaks a clip).
 */
export function sweepSources(store: Store, cfg: Config): { freed: number; mb: number } {
  let freed = 0, mb = 0; if (cfg.storage.autoCleanup === false || (cfg.storage.autoCleanup === undefined && !cfg.storage.freeAfterRender)) return { freed, mb };
  const keep = Math.max(1, cfg.storage.sourceKeepDays ?? 7);
  for (const v of store.all<{ id: number; path: string }>(`SELECT v.id, v.path FROM videos v JOIN sources s ON s.id=v.source_id WHERE s.kind='youtube_video' AND NOT EXISTS (SELECT 1 FROM kv WHERE k='local:pruned:'||v.id) ORDER BY v.id LIMIT 200`)) {
    try {
      if (!existsSync(v.path) || !resolve(v.path).startsWith(resolve(cfg.dirs.sources) + sep)) continue;
      if (store.get(`SELECT 1 FROM jobs j WHERE j.state IN ${ACTIVE} AND (j.key='analyze:'||?1 OR (j.kind='render' AND j.key IN (SELECT 'render:'||id FROM candidates WHERE video_id=?1)) OR (j.kind IN ('meta','rerender') AND j.key IN (SELECT 'meta:'||k.id FROM clips k JOIN candidates c ON c.id=k.candidate_id WHERE c.video_id=?1)))`, v.id)) continue;
      if (store.get(`SELECT 1 FROM candidates c WHERE c.video_id=? AND c.status='candidate' AND NOT EXISTS (SELECT 1 FROM clips k WHERE k.candidate_id=c.id)`, v.id)) continue;
      const clips = store.all<{ id: number; qc: number | null; pub: number; age: number }>(`SELECT k.id, k.qc_pass AS qc, EXISTS (SELECT 1 FROM uploads u WHERE u.clip_id=k.id AND u.state='PUBLISHED') AS pub, (julianday('now') - julianday(k.created_at)) AS age FROM clips k JOIN candidates c ON c.id=k.candidate_id WHERE c.video_id=?`, v.id);
      if (!clips.length) continue;
      const allDone = clips.every((c) => c.pub || c.qc === 0); const stale = Math.min(...clips.map((c) => c.age)) >= keep; // youngest clip older than keep days
      if (!allDone && !stale) continue;
      const mbv = statSync(v.path).size / 1048576; rmSync(v.path, { force: true });
      store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `local:pruned:${v.id}`, new Date().toISOString());
      info(`Source cleaned up after publish: ${v.path.split(sep).pop()}`, { video: v.id, freedMb: Math.round(mbv), reason: allDone ? 'all clips published/finished' : `no activity for ${keep} days` }); freed++; mb += mbv;
    } catch (e) { info('source cleanup skipped (disk/file error), retry next cycle', { video: v.id, err: (e as Error).message }); }
  }
  return { freed, mb: Math.round(mb) };
}
