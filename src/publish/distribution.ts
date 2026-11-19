import type { Store } from '../db.ts';

/** A clip's fan-out to several destinations: derived from the independent destination jobs (no extra state to get out of sync). */
export type DistStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'BLOCKED' | 'RETRY' | 'FAILED' | 'IN_PROGRESS';
export interface DistJob { uploadId: number; platform: string; channelSlug: string | null; destinationId: string | null; state: string; error: string | null; scheduledAt: string | null; remoteId: string | null }
export interface Distribution { clipId: number; title: string; status: DistStatus; done: number; total: number; jobs: DistJob[] }

const DONE = new Set(['PUBLISHED', 'ANALYTICS_WAIT', 'ANALYZING', 'LEARNING', 'NEXT_CYCLE']);
const BLOCK = /^(NETWORK_ERROR|PUBLISH_DISABLED|PUBLIC_DISABLED|NEEDS_APPROVAL|NOT_READY|QUOTA_EXCEEDED|AUTH_|WAIT_SCHEDULE|WAIT_PUBLIC_DELAY|MANUAL_POST_REQUIRED|UNLISTED_BUFFER|HELD_RESTRICTED|SANDBOX_HOLD|DESTINATION_DISABLED)/;

export function statusOf(jobs: Pick<DistJob, 'state' | 'error'>[]): DistStatus {
  const done = jobs.filter((j) => DONE.has(j.state)).length, open = jobs.filter((j) => !DONE.has(j.state) && j.state !== 'FAILED' && j.state !== 'QC_FAILED');
  const failed = jobs.filter((j) => j.state === 'FAILED' || j.state === 'QC_FAILED').length, blocked = open.filter((j) => j.error && BLOCK.test(j.error)).length;
  if (done === jobs.length) return 'SUCCESS';
  if (done > 0 && (failed > 0 || open.length > 0)) return 'PARTIAL_SUCCESS';
  if (failed === jobs.length) return 'FAILED';
  if (blocked > 0 && blocked === open.length && failed === 0) return 'BLOCKED';
  if (failed > 0 && open.length === 0) return 'FAILED';
  if (failed > 0) return 'RETRY';
  return 'IN_PROGRESS';
}

export function listDistributions(store: Store, limit = 100): Distribution[] {
  const rows = store.all<{ id: number; clip_id: number; platform: string; state: string; error: string | null; scheduled_at: string | null; remote_id: string | null; destination_id: string | null; slug: string | null; title: string | null }>(
    `SELECT u.id, u.clip_id, u.platform, u.state, u.error, u.scheduled_at, u.remote_id, u.destination_id, ch.slug AS slug, json_extract(c.metadata_json,'$.title') AS title
     FROM uploads u JOIN clips c ON c.id=u.clip_id LEFT JOIN channels ch ON ch.id=u.channel_id WHERE u.clip_id IN (SELECT clip_id FROM uploads ORDER BY id DESC LIMIT ?) ORDER BY u.clip_id DESC, u.id`, limit * 4);
  const by = new Map<number, Distribution>();
  for (const r of rows) {
    const d = by.get(r.clip_id) ?? { clipId: r.clip_id, title: r.title ?? `clip ${r.clip_id}`, status: 'IN_PROGRESS' as DistStatus, done: 0, total: 0, jobs: [] }; by.set(r.clip_id, d);
    d.jobs.push({ uploadId: r.id, platform: r.platform, channelSlug: r.slug, destinationId: r.destination_id, state: r.state, error: r.error, scheduledAt: r.scheduled_at, remoteId: r.remote_id });
  }
  const out = [...by.values()].slice(0, limit); for (const d of out) { d.total = d.jobs.length; d.done = d.jobs.filter((j) => DONE.has(j.state)).length; d.status = statusOf(d.jobs); } return out;
}
