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
};

export interface ClipFacts { width: number; height: number; duration: number; title: string; description: string; qcPass: boolean; authorized: boolean; tags?: string[]; thumbnailPath?: string | null; categoryId?: string; language?: string }
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
  publish(remoteId: string, at: Date | null): Promise<void>;
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

export function queueUpload(store: Store, clipId: number, platform: string): number {
  const clip = store.get<{ output_id: string; qc_pass: number | null }>('SELECT output_id, qc_pass FROM clips WHERE id=?', clipId);
  if (!clip) throw new Error(`Unknown clip ${clipId}`);
  const key = `${platform}:${clip.output_id}`;
  const ex = store.get<{ id: number }>('SELECT id FROM uploads WHERE idempotency_key=?', key);
  if (ex) return ex.id; // never queue duplicates
  const r = store.exec('INSERT INTO uploads(clip_id, platform, state, idempotency_key) VALUES (?,?,?,?)', clipId, platform, clip.qc_pass ? 'QC_PASSED' : 'QC_FAILED', key);
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
  const u = store.get<{ id: number; clip_id: number; platform: string; state: UploadState; idempotency_key: string; remote_id: string | null }>('SELECT id, clip_id, platform, state, idempotency_key, remote_id FROM uploads WHERE id=?', uploadId);
  if (!u) throw new Error(`Unknown upload ${uploadId}`);
  const clip = store.get<{ edited_path: string }>('SELECT edited_path FROM clips WHERE id=?', u.clip_id)!;
  const from = u.state;
  try {
    switch (from) {
      case 'READY_FOR_QC': case 'FAILED': { const e = validateForPlatform(u.platform, o.facts); if (e.length) { setState(store, u.id, from, 'QC_FAILED', { err: e.join('; ') }); return 'QC_FAILED'; } setState(store, u.id, from, 'QC_PASSED'); return 'QC_PASSED'; }
      case 'QC_FAILED': return 'QC_FAILED';
      case 'QC_PASSED': { const e = validateForPlatform(u.platform, o.facts); if (e.length) { setState(store, u.id, from, 'QC_FAILED', { err: e.join('; ') }); return 'QC_FAILED'; } setState(store, u.id, from, 'UPLOAD_PENDING'); return 'UPLOAD_PENDING'; }
      case 'UPLOAD_PENDING': assertPublishAllowed(cfg, 'unlisted'); setState(store, u.id, from, 'UPLOADING'); return 'UPLOADING';
      case 'UPLOADING': {
        assertPublishAllowed(cfg, 'unlisted');
        const r = await adapter.upload({ filePath: clip.edited_path, title: o.facts.title, description: o.facts.description, tags: o.facts.tags ?? [], visibility: 'unlisted', idempotencyKey: u.idempotency_key, categoryId: o.facts.categoryId, language: o.facts.language });
        if (adapter.thumbnail && o.facts.thumbnailPath) { try { await adapter.thumbnail(r.remoteId, o.facts.thumbnailPath); } catch { /* thumbnails are optional */ } }
        setState(store, u.id, from, 'UPLOAD_VERIFYING', { remote: r.remoteId, vis: 'unlisted' }); return 'UPLOAD_VERIFYING';
      }
      case 'UPLOAD_VERIFYING': {
        assertPublishAllowed(cfg, 'unlisted');
        const v = await adapter.verify(u.remote_id!, { title: o.facts.title, visibility: 'unlisted' });
        if (!v.processed || !v.metadataMatches || v.visibility === 'public') throw new Error(`remote verify failed: ${JSON.stringify(v)}`);
        setState(store, u.id, from, 'UNLISTED_VERIFIED'); return 'UNLISTED_VERIFIED';
      }
      case 'UNLISTED_VERIFIED': {
        if (!o.approve && !o.scheduledAt) throw new Error('NEEDS_APPROVAL: pass approve or a scheduled time (owner decision)');
        setState(store, u.id, from, 'SCHEDULED_OR_APPROVED', { at: o.scheduledAt?.toISOString() ?? null }); return 'SCHEDULED_OR_APPROVED';
      }
      case 'SCHEDULED_OR_APPROVED': {
        assertPublishAllowed(cfg, 'public');
        await adapter.publish(u.remote_id!, o.scheduledAt ?? null);
        setState(store, u.id, from, 'PUBLISHED', { vis: 'public' }); return 'PUBLISHED';
      }
      default: { const n = nextState(from); if (!n) return from; setState(store, u.id, from, n); return n; }
    }
  } catch (e) {
    const msg = (e as Error).message;
    // Gate / approval / not-ready / quota / auth blocks are NOT failures: state stays so it resumes later.
    if (/^(PUBLISH_DISABLED|PUBLIC_DISABLED|NEEDS_APPROVAL|NOT_READY|QUOTA_EXCEEDED|AUTH_)/.test(msg)) { store.exec(`UPDATE uploads SET error=?, updated_at=datetime('now') WHERE id=?`, msg, u.id); throw e; }
    setState(store, u.id, from, 'FAILED', { err: msg.slice(0, 500) });
    // keep a retry pointer: FAILED re-enters via READY_FOR_QC which re-validates, upload key is idempotent
    throw e;
  }
}
