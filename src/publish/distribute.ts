import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { listDestinations } from '../accounts/destinations.ts';
import { getChannel, scheduleFor, listChannels } from '../channels.ts';
import { queueUpload } from './machine.ts';
import { planFromStore } from '../schedule/analytics.ts';

/** Many clips x many destination accounts -> one independent job per pair. Preview first (nothing written), then confirm. */
export interface DistItem { clipId: number; title: string; destinationId: string; destination: string; platform: string; channel: string | null; timezone: string; plannedAt: string | null; status: 'new' | 'duplicate' | 'blocked'; reason?: string }
const UPLOAD_PLATFORM: Record<string, string> = { youtube: 'youtube_shorts', facebook: 'facebook_reels', instagram: 'instagram_reels', tiktok: 'tiktok' };

export function distribute(store: Store, cfg: Config, req: { clipIds: number[]; destinations: string[]; confirm?: boolean }, now = new Date()): { items: DistItem[]; created: number } {
  const dests = listDestinations(store, cfg); const chans = listChannels(store, true); const items: DistItem[] = []; let created = 0;
  for (const clipId of [...new Set(req.clipIds)].slice(0, 50)) {
    const clip = store.get<{ output_id: string; qc_pass: number | null; metadata_json: string | null }>('SELECT output_id, qc_pass, metadata_json FROM clips WHERE id=?', clipId);
    const title = (() => { try { return (JSON.parse(clip?.metadata_json ?? '{}') as { title?: string }).title ?? `clip ${clipId}`; } catch { return `clip ${clipId}`; } })();
    for (const did of [...new Set(req.destinations)].slice(0, 20)) {
      const d = dests.find((x) => x.id === did); const platform = d ? UPLOAD_PLATFORM[d.platform] : undefined;
      const base = { clipId, title, destinationId: did, destination: d?.name ?? did, platform: platform ?? '?', channel: d?.channelSlug ?? null, timezone: cfg.timezone, plannedAt: null as string | null };
      if (!clip) { items.push({ ...base, status: 'blocked', reason: 'clip nahi mili' }); continue; }
      if (!d || !platform) { items.push({ ...base, status: 'blocked', reason: 'account nahi mila' }); continue; }
      if (!clip.qc_pass) { items.push({ ...base, status: 'blocked', reason: 'clip QC pass nahi hui' }); continue; }
      if (!d.enabled || d.status === 'disconnected') { items.push({ ...base, status: 'blocked', reason: d.enabled ? 'account disconnected' : 'account disabled' }); continue; }
      if (d.status === 'expired') { items.push({ ...base, status: 'blocked', reason: 'login expired — Reconnect' }); continue; }
      const ch = d.channelSlug ? chans.find((c) => c.slug === d.channelSlug) : undefined; const sched = ch ? scheduleFor(cfg, ch) : undefined; const tz = sched?.timezone ?? cfg.timezone;
      let plannedAt: string | null = null; try { if (ch && sched) plannedAt = planFromStore(store, { n: 1, tz, cfg: sched, from: now, platform, channelId: ch.id }).slots[0]?.at.toISOString() ?? null; } catch { /* preview only */ }
      const own = store.get<{ channel_id: number | null }>(`SELECT s.channel_id FROM clips c JOIN candidates k ON k.id=c.candidate_id JOIN videos v ON v.id=k.video_id JOIN sources s ON s.id=v.source_id WHERE c.id=?`, clipId)?.channel_id ?? null;
      const channelId = ch?.id ?? own ?? undefined; const key = `${platform}:${clip.output_id}@dest:${did}`;
      const dup = store.get('SELECT 1 FROM uploads WHERE idempotency_key=?', key);
      const item: DistItem = { ...base, timezone: tz, plannedAt, status: dup ? 'duplicate' : 'new', ...(dup ? { reason: 'is account par pehle se queue hai' } : {}) }; items.push(item);
      if (req.confirm && !dup) { queueUpload(store, clipId, platform, channelId, did); created++; }
    }
  }
  return { items, created };
}
export { getChannel };
