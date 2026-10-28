import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { assertPublishAllowed } from '../config.ts';

export const STATES = ['READY_FOR_QC', 'QC_PASSED', 'UPLOAD_PENDING', 'UPLOADING', 'UPLOAD_VERIFYING', 'UNLISTED_VERIFIED', 'SCHEDULED_OR_APPROVED', 'PUBLISHED', 'ANALYTICS_WAIT', 'ANALYZING', 'LEARNING', 'NEXT_CYCLE'] as const;
export type UploadState = (typeof STATES)[number] | 'FAILED' | 'QC_FAILED';

/** Linear machine; FAILED can retry back to the state it failed from (resumable, idempotent). */
export function nextState(s: UploadState): UploadState | null {
  const i = STATES.indexOf(s as (typeof STATES)[number]);
  return i >= 0 && i < STATES.length - 1 ? STATES[i + 1]! : null;
}

export interface Constraints { maxDurationSec: number; minDurationSec: number; aspect: 'vertical' | 'any'; maxTitle: number; maxDescription: number; note: string }
/** Conservative defaults. Owner MUST verify against each platform's current docs and override in data/config.json (limits change). */
export const PLATFORM_CONSTRAINTS: Record<string, Constraints> = {
  youtube_shorts: { maxDurationSec: 60, minDurationSec: 1, aspect: 'vertical', maxTitle: 100, maxDescription: 5000, note: 'conservative 60s; verify current YouTube Shorts limit' },
  instagram_reels: { maxDurationSec: 90, minDurationSec: 3, aspect: 'vertical', maxTitle: 150, maxDescription: 2200, note: 'conservative 90s; verify current Reels limit' },
  facebook_reels: { maxDurationSec: 90, minDurationSec: 3, aspect: 'vertical', maxTitle: 150, maxDescription: 2200, note: 'conservative; verify' },
  tiktok: { maxDurationSec: 60, minDurationSec: 3, aspect: 'vertical', maxTitle: 150, maxDescription: 2200, note: 'conservative; verify' },
  telegram: { maxDurationSec: 600, minDurationSec: 1, aspect: 'any', maxTitle: 200, maxDescription: 800, note: 'caption limit 1024 incl. title; bot upload ~50MB (verify)' },
  discord: { maxDurationSec: 600, minDurationSec: 1, aspect: 'any', maxTitle: 200, maxDescription: 1700, note: 'message limit 2000; file limit depends on server boost (25MB default, verify)' },
  mastodon: { maxDurationSec: 120, minDurationSec: 1, aspect: 'any', maxTitle: 150, maxDescription: 300, note: 'status 500 chars default; instance limits differ (verify)' },
  x: { maxDurationSec: 140, minDurationSec: 1, aspect: 'any', maxTitle: 120, maxDescription: 150, note: 'manual; verify limits' },
  linkedin: { maxDurationSec: 600, minDurationSec: 3, aspect: 'any', maxTitle: 150, maxDescription: 2900, note: 'manual; verify limits' },
  pinterest: { maxDurationSec: 300, minDurationSec: 4, aspect: 'any', maxTitle: 100, maxDescription: 500, note: 'manual; verify limits' },
  snapchat: { maxDurationSec: 60, minDurationSec: 5, aspect: 'vertical', maxTitle: 100, maxDescription: 250, note: 'manual; verify limits' },
  threads: { maxDurationSec: 300, minDurationSec: 1, aspect: 'any', maxTitle: 150, maxDescription: 500, note: 'manual; verify limits' },
  bluesky: { maxDurationSec: 60, minDurationSec: 1, aspect: 'any', maxTitle: 150, maxDescription: 300, note: 'manual; verify limits' },
  reddit: { maxDurationSec: 900, minDurationSec: 1, aspect: 'any', maxTitle: 300, maxDescription: 3000, note: 'manual; subreddit rules apply' },
};

export interface ClipFacts { width: number; height: number; duration: number; title: string; description: string; qcPass: boolean; authorized: boolean; tags?: string[]; thumbnailPath?: string | null; categoryId?: string; language?: string; risks?: { severity: 'block' | 'warn'; category: string; match: string }[] }
export function validateForPlatform(platform: string, f: ClipFacts): string[] {
  const c = PLATFORM_CONSTRAINTS[platform]; const e: string[] = [];
  if (!c) return [`unknown platform ${platform}`];
  if (!f.qcPass) e.push('media QC not passed');
  if (!f.authorized) e.push('source rights/authorization not confirmed by owner');
  if (f.duration > c.maxDurationSec) e.push(`duration ${f.duration.toFixed(1)}s > ${c.maxDurationSec}s`);
  if (f.duration < c.minDurationSec) e.push(`duration < ${c.minDurationSec}s`);
  if (c.aspect === 'vertical' && f.height <= f.width) e.push('not vertical');
  if (f.title.length > c.maxTitle) e.push('title too long');
  if (f.description.length > c.maxDescription) e.push('description too long');
  for (const r of f.risks ?? []) if (r.severity === 'block') e.push(`safety: ${r.category} ("${r.match}")`);
  return e;
}

export interface Adapter {
  readonly name: string;
  /** Upload privately/unlisted. Must be idempotent on idempotencyKey. Returns remote id. */
  upload(a: { filePath: string; title: string; description: string; tags: string[]; visibility: 'private' | 'unlisted'; idempotencyKey: string; categoryId?: string; language?: string }): Promise<{ remoteId: string }>;
  /** Check REMOTE processing + metadata state (not just HTTP 200). Throw `NOT_READY: ...` while the platform is still processing. */
  verify(remoteId: string, expect?: { title: string; visibility: string }): Promise<{ processed: boolean; metadataMatches: boolean; visibility: string }>;
  /** Best-effort custom thumbnail; returns false (never throws for ordinary rejections). */
  thumbnail?(remoteId: string, path: string): Promise<boolean>;
  /** May return the final remote id/URL. `local` adapters never touch the network (manual platforms) so the publish gates don't apply to them. */
  publish(remoteId: string, at: Date | null): Promise<void | { remoteId?: string }>;
  /** Optional: what the platform itself reports about restrictions on an uploaded video (region blocks, rejection). Content ID claims are NOT part of YouTube's API. */
  restrictions?(remoteId: string): Promise<{ blockedRegions: string[]; allowedOnly: string[] | null; rejectionReason: string | null }>;
  readonly local?: boolean;
}

/** Records intents only; touches no network. Used for dry-runs and tests. */
export class DryRunAdapter implements Adapter {
  readonly name = 'dryrun';
  calls: string[] = [];
  private store = new Map<string, { vis: string; title: string }>();
  async upload(a: Parameters<Adapter['upload']>[0]) {
    this.calls.push(`upload:${a.idempotencyKey}`);
    const id = `dry_${a.idempotencyKey}`; // idempotent: same key -> same id, no duplicate
    this.store.set(id, { vis: a.visibility, title: a.title });
    return { remoteId: id };
  }
  async verify(id: string, _expect?: { title: string; visibility: string }) { const r = this.store.get(id); return { processed: !!r, metadataMatches: !!r, visibility: r?.vis ?? 'unknown' }; }
  async publish(id: string) { this.calls.push(`publish:${id}`); const r = this.store.get(id); if (r) r.vis = 'public'; }
}

/** Channel a clip belongs to: clip -> video -> source -> channel (falls back to 'main'). */
function channelIdOfClip(store: Store, clipId: number): number | null {
  const r = store.get<{ cid: number | null }>('SELECT s.channel_id AS cid FROM clips c JOIN candidates k ON k.id=c.candidate_id JOIN videos v ON v.id=k.video_id LEFT JOIN sources s ON s.id=v.source_id WHERE c.id=?', clipId);
  return r?.cid ?? store.get<{ id: number }>(`SELECT id FROM channels WHERE slug='main'`)?.id ?? null;
}

export function queueUpload(store: Store, clipId: number, platform: string): number {
  const clip = store.get<{ output_id: string; qc_pass: number | null }>('SELECT output_id, qc_pass FROM clips WHERE id=?', clipId);
  if (!clip) throw new Error(`Unknown clip ${clipId}`);
  const key = `${platform}:${clip.output_id}`;
  const ex = store.get<{ id: number }>('SELECT id FROM uploads WHERE idempotency_key=?', key);
  if (ex) return ex.id; // never queue duplicates
  const chId = channelIdOfClip(store, clipId);
  const r = store.exec('INSERT INTO uploads(clip_id, platform, state, idempotency_key, channel_id) VALUES (?,?,?,?,?)', clipId, platform, clip.qc_pass ? 'QC_PASSED' : 'QC_FAILED', key, chId);
  store.logState('upload', r.lastId, null, clip.qc_pass ? 'QC_PASSED' : 'QC_FAILED', 'queued');
  return r.lastId;
}

function setState(store: Store, id: number, from: string, to: string, extra: { remote?: string; err?: string | null; vis?: string; at?: string | null } = {}) {
  store.exec(`UPDATE uploads SET state=?, remote_id=COALESCE(?, remote_id), error=?, visibility=COALESCE(?, visibility), scheduled_at=COALESCE(?, scheduled_at), updated_at=datetime('now') WHERE id=?`, to, extra.remote ?? null, extra.err ?? null, extra.vis ?? null, extra.at ?? null, id);
  store.logState('upload', id, from, to, extra.err ?? undefined);
}

/**
 * Advance ONE step. Gates are enforced here (not just in config): any step that would touch a remote platform
 * calls assertPublishAllowed first. Remote state is verified before moving on. Failures are recorded and retryable.
 */
export async function advanceUpload(store: Store, cfg: Config, adapter: Adapter, uploadId: number, o: { facts: ClipFacts; scheduledAt?: Date | null; approve?: boolean }): Promise<UploadState> {
  const u = store.get<{ id: number; clip_id: number; platform: string; state: UploadState; idempotency_key: string; remote_id: string | null; scheduled_at: string | null }>('SELECT id, clip_id, platform, state, idempotency_key, remote_id, scheduled_at FROM uploads WHERE id=?', uploadId);
  if (!u) throw new Error(`Unknown upload ${uploadId}`);
  const clip = store.get<{ edited_path: string }>('SELECT edited_path FROM clips WHERE id=?', u.clip_id)!;
  const from = u.state;
  try {
    switch (from) {
      case 'READY_FOR_QC': case 'FAILED': { const e = validateForPlatform(u.platform, o.facts); if (e.length) { setState(store, u.id, from, 'QC_FAILED', { err: e.join('; ') }); return 'QC_FAILED'; } setState(store, u.id, from, 'QC_PASSED'); return 'QC_PASSED'; }
      case 'QC_FAILED': return 'QC_FAILED';
      case 'QC_PASSED': { const e = validateForPlatform(u.platform, o.facts); if (e.length) { setState(store, u.id, from, 'QC_FAILED', { err: e.join('; ') }); return 'QC_FAILED'; } setState(store, u.id, from, 'UPLOAD_PENDING'); return 'UPLOAD_PENDING'; }
      case 'UPLOAD_PENDING': if (!adapter.local) assertPublishAllowed(cfg, 'unlisted'); setState(store, u.id, from, 'UPLOADING'); return 'UPLOADING';
      case 'UPLOADING': {
        if (!adapter.local) assertPublishAllowed(cfg, 'unlisted');
        const r = await adapter.upload({ filePath: clip.edited_path, title: o.facts.title, description: o.facts.description, tags: o.facts.tags ?? [], visibility: 'unlisted', idempotencyKey: u.idempotency_key, categoryId: o.facts.categoryId, language: o.facts.language });
        if (adapter.thumbnail && o.facts.thumbnailPath) { try { await adapter.thumbnail(r.remoteId, o.facts.thumbnailPath); } catch { /* thumbnails are optional */ } }
        setState(store, u.id, from, 'UPLOAD_VERIFYING', { remote: r.remoteId, vis: 'unlisted' }); return 'UPLOAD_VERIFYING';
      }
      case 'UPLOAD_VERIFYING': {
        if (!adapter.local) assertPublishAllowed(cfg, 'unlisted');
        const v = await adapter.verify(u.remote_id!, { title: o.facts.title, visibility: 'unlisted' });
        if (!v.processed || !v.metadataMatches || v.visibility === 'public') throw new Error(`remote verify failed: ${JSON.stringify(v)}`);
        setState(store, u.id, from, 'UNLISTED_VERIFIED'); return 'UNLISTED_VERIFIED';
      }
      case 'UNLISTED_VERIFIED': {
        if (!o.approve && !o.scheduledAt) throw new Error('NEEDS_APPROVAL: pass approve or a scheduled time (owner decision)');
        if (adapter.restrictions && u.remote_id) { // unlisted buffer + platform-reported restrictions: hold instead of going public when something is reported
          if (!o.approve && (cfg.automation.unlistedBufferMin ?? 10) > 0) { const row = store.get<{ updated_at: string }>('SELECT updated_at FROM uploads WHERE id=?', u.id); const ageMin = row ? (Date.now() - Date.parse(row.updated_at.replace(' ', 'T') + 'Z')) / 60_000 : 999; if (ageMin < (cfg.automation.unlistedBufferMin ?? 10)) throw new Error(`UNLISTED_BUFFER: wait ${Math.ceil((cfg.automation.unlistedBufferMin ?? 10) - ageMin)} more min on unlisted before going public`); }
          const rs = await adapter.restrictions(u.remote_id).catch(() => null);
          if (rs && (rs.blockedRegions.length || rs.allowedOnly || rs.rejectionReason)) throw new Error(`HELD_RESTRICTED: platform reports ${rs.rejectionReason ? 'rejection ' + rs.rejectionReason : rs.blockedRegions.length ? 'blocked in ' + rs.blockedRegions.join(',') : 'region-limited to ' + (rs.allowedOnly ?? []).join(',')} — owner decides (Studio → Copyright)`);
        }
        setState(store, u.id, from, 'SCHEDULED_OR_APPROVED', { at: o.scheduledAt?.toISOString() ?? null }); return 'SCHEDULED_OR_APPROVED';
      }
      case 'SCHEDULED_OR_APPROVED': {
        if (!adapter.local) assertPublishAllowed(cfg, 'public');
        // the time chosen at approval is stored; a stored time already in the past means "publish now"
        const stored = u.scheduled_at ? new Date(u.scheduled_at) : null; const when = o.scheduledAt ?? (stored && stored.getTime() > Date.now() ? stored : null);
        const pr = await adapter.publish(u.remote_id!, when);
        setState(store, u.id, from, 'PUBLISHED', { vis: 'public', ...(pr && pr.remoteId ? { remote: pr.remoteId } : {}) }); return 'PUBLISHED';
      }
      default: { const n = nextState(from); if (!n) return from; setState(store, u.id, from, n); return n; }
    }
  } catch (e) {
    const msg = (e as Error).message;
    // Gate / approval / not-ready / quota / auth blocks are NOT failures: state stays so it resumes later.
    if (/^(PUBLISH_DISABLED|PUBLIC_DISABLED|NEEDS_APPROVAL|NOT_READY|QUOTA_EXCEEDED|AUTH_|WAIT_SCHEDULE|MANUAL_POST_REQUIRED|UNLISTED_BUFFER|HELD_RESTRICTED)/.test(msg)) { store.exec(/^(UNLISTED_BUFFER|HELD_RESTRICTED)/.test(msg) ? `UPDATE uploads SET error=? WHERE id=?` : `UPDATE uploads SET error=?, updated_at=datetime('now') WHERE id=?`, msg, u.id); throw e; } // the buffer clock must not restart on each blocked attempt
    setState(store, u.id, from, 'FAILED', { err: msg.slice(0, 500) });
    // keep a retry pointer: FAILED re-enters via READY_FOR_QC which re-validates, upload key is idempotent
    throw e;
  }
}
