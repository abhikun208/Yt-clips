import { effectiveSummary } from './flags.ts';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { scoreMetadata } from '../seo/score.ts';
import { hourStats } from '../schedule/analytics.ts';
import { warn } from '../util/log.ts';

/**
 * Autopilot orchestration around the existing automation loop (service.automationTick):
 *   QC passed -> (title/desc/tags already written at render, Roman Hinglish) -> CTR estimate stored here ->
 *   queue (round-robin router) -> best-time slot (schedule/analytics) -> publish; comments are drafted by collectYoutubeComments.
 * This module adds: the global Pause switch, a plain status per clip (for the dashboard), and the CTR estimate.
 * Owner safety gates (publish enabled / public / auto-comment-post) stay in data/config.json and are NOT bypassed here.
 */
const KEY = 'autopilot:paused';
export const isPaused = (store: Store): boolean => store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', KEY)?.v === '1';
export function setPaused(store: Store, on: boolean): void { store.exec('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', KEY, on ? '1' : '0'); }

export interface AutopilotState { on: boolean; paused: boolean; handsFree: boolean; badge: string; missing: string[]; effective: string; autoPublic: { enabled: boolean; minMin: number; maxMin: number } | null; pendingPublic: number }
/** handsFree = nothing for the owner to click: queue + approve are automatic and no review is required. */
export function autopilotState(store: Store, cfg: Config): AutopilotState {
  const a = cfg.automation; const paused = isPaused(store); const missing: string[] = [];
  if (!a.autoQueue) missing.push('autoQueue off (npm run cli -- automation on)');
  if (a.autoQueue && !a.autoApprove) missing.push('autoApprove off: clips scheduling ke liye approval maangengi');
  if (a.requireReview) missing.push('requireReview on: pehle review karna padega');
  if (!cfg.gates?.publishEnabled) missing.push('gates.publishEnabled off: upload sirf private/dry-run');
  const on = !!a.autoQueue && !paused; const handsFree = on && !!a.autoApprove && !a.requireReview;
  return { on, paused, handsFree, badge: paused ? '⏸ Auto-Pilot PAUSED' : on ? (handsFree ? '🤖 Auto-Pilot ON' : '🤖 Auto-Pilot ON (kuch approval baaki)') : '⚪ Auto-Pilot OFF', missing, effective: effectiveSummary(a, cfg.gates ?? {}), autoPublic: a.autoPublic?.enabled ? a.autoPublic : null, pendingPublic: store.get<{ n: number }>("SELECT COUNT(*) n FROM kv WHERE k LIKE 'pubat:%' AND CAST(SUBSTR(k,7) AS INTEGER) IN (SELECT id FROM uploads WHERE state='UNLISTED_VERIFIED')")?.n ?? 0 };
}

/** One word for the dashboard: what happened to this clip automatically. */
export function clipStatus(store: Store, clipId: number, review: string, qcPass: boolean | number | null): string {
  const u = store.get<{ state: string; scheduled_at: string | null }>('SELECT state, scheduled_at FROM uploads WHERE clip_id=? ORDER BY id DESC LIMIT 1', clipId);
  if (u) { if (['PUBLISHED', 'ANALYTICS_WAIT', 'ANALYZING', 'LEARNING', 'NEXT_CYCLE'].includes(u.state)) return 'Published'; if (u.state === 'FAILED' || u.state === 'QC_FAILED') return 'Failed'; return u.scheduled_at ? 'Scheduled' : 'Queued'; }
  if (review === 'rejected') return 'Rejected'; if (!qcPass) return 'QC fail'; return review === 'approved' ? 'Ready' : 'Waiting';
}

/** CTR estimate = transparent checklist score (title/thumbnail text), nudged by the channel's own history when it has any. Not a promise of views. */
export function ctrEstimate(store: Store, cfg: Config, clipId: number): { ctr: number; basis: string } | null {
  const row = store.get<{ metadata_json: string | null }>('SELECT metadata_json FROM clips WHERE id=?', clipId); if (!row?.metadata_json) return null;
  try { const s = scoreMetadata(JSON.parse(row.metadata_json)); let basis = 'default high-engagement checklist';
    try { if (hourStats(store, cfg.timezone, 'youtube_shorts').some((h) => h.samples)) basis = 'checklist + channel history'; } catch { /* no analytics yet */ }
    return { ctr: s.ctr, basis }; } catch { return null; }
}

/** Run at the start of every automation tick. Returns false when paused (tick must do nothing). Never throws. */
export function autopilotPass(store: Store, cfg: Config): boolean {
  if (isPaused(store)) return false;
  try {
    for (const c of store.all<{ id: number }>(`SELECT id FROM clips WHERE qc_pass=1 AND review!='rejected' AND NOT EXISTS (SELECT 1 FROM kv WHERE k='autopilot:ctr:'||clips.id) LIMIT 20`)) {
      const e = ctrEstimate(store, cfg, c.id); if (e) store.exec('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING', `autopilot:ctr:${c.id}`, JSON.stringify({ ...e, at: new Date().toISOString() }));
    }
  } catch (e) { warn('autopilot pass failed', { why: (e as Error).message.slice(0, 120) }); }
  return true;
}

/**
 * Delayed auto-public. The moment an upload is first seen as UNLISTED_VERIFIED we pick ONE random time in the owner's [min,max] window and persist it
 * (kv `pubat:<uploadId>`), so a restart neither re-rolls nor loses it, and the same upload can never be published twice from two ticks.
 */
export function publicAtFor(store: Store, cfg: Config, uploadId: number, now = new Date(), rnd: () => number = Math.random): Date | null {
  const ap = cfg.automation.autoPublic; if (!ap?.enabled) return null; const key = `pubat:${uploadId}`;
  const cur = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', key)?.v; if (cur) { const d = new Date(cur); if (!Number.isNaN(d.getTime())) return d; }
  const min = ap.minMin + Math.floor(rnd() * (ap.maxMin - ap.minMin + 1)); const at = new Date(now.getTime() + min * 60_000);
  store.exec('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING', key, at.toISOString());
  return new Date(store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', key)!.v);
}
