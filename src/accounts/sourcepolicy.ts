import type { Store } from '../db.ts';
import { mainChannel } from '../channels.ts';

/**
 * Per-source upload permission (owner decides which channels a source's clips may reach).
 *  open      : own channel + every enabled mapping (existing behaviour); an explicit Distribute to another account is still allowed.
 *  own_only  : EXCLUSIVE: clips go only to the source's own channel. Mappings and Distribute to other channels are blocked.
 *  skipOwn   : (open mode) the own channel is NOT used; only the mapped channels get the clips.
 * Enforced where jobs are queued (auto-queue) AND where they would leave (advance), so no path can bypass it.
 */
export interface SourcePolicy { mode: 'open' | 'own_only'; skipOwn: boolean }
export const DEFAULT_POLICY: SourcePolicy = { mode: 'open', skipOwn: false };

/** true once the owner has saved a policy for this source; before that nothing is restricted (older jobs keep working exactly as before) */
export function hasSourcePolicy(store: Store, sourceId: number): boolean { try { return !!(JSON.parse(store.get<{ meta_json: string | null }>('SELECT meta_json FROM sources WHERE id=?', sourceId)?.meta_json || '{}') as { uploadPolicy?: unknown }).uploadPolicy; } catch { return false; } }
export function getSourcePolicy(store: Store, sourceId: number): SourcePolicy {
  const r = store.get<{ meta_json: string | null }>('SELECT meta_json FROM sources WHERE id=?', sourceId); let p: Partial<SourcePolicy> = {};
  try { p = (JSON.parse(r?.meta_json || '{}') as { uploadPolicy?: Partial<SourcePolicy> }).uploadPolicy ?? {}; } catch { /* bad legacy data = default */ }
  return { mode: p.mode === 'own_only' ? 'own_only' : 'open', skipOwn: p.skipOwn === true && p.mode !== 'own_only' };
}
export function setSourcePolicy(store: Store, sourceId: number, i: { mode?: string; skipOwn?: boolean }): SourcePolicy {
  const r = store.get<{ meta_json: string | null }>('SELECT meta_json FROM sources WHERE id=?', sourceId); if (!r) throw new Error('not found: source');
  if (i.mode !== undefined && !['open', 'own_only'].includes(i.mode)) throw new Error('invalid: mode must be open or own_only');
  const cur = getSourcePolicy(store, sourceId); const next: SourcePolicy = { mode: (i.mode as SourcePolicy['mode']) ?? cur.mode, skipOwn: i.skipOwn ?? cur.skipOwn };
  if (next.mode === 'own_only') next.skipOwn = false;
  if (next.skipOwn && !store.get(`SELECT 1 FROM source_destinations WHERE source_id=? AND enabled=1`, sourceId)) throw new Error('invalid: own channel tabhi band ho sakta hai jab kam se kam ek dusra channel mapped ho (warna clips kahin nahi jaayengi)');
  let meta: Record<string, unknown> = {}; try { meta = JSON.parse(r.meta_json || '{}') as Record<string, unknown>; } catch { /* reset */ }
  meta.uploadPolicy = next; store.exec('UPDATE sources SET meta_json=? WHERE id=?', JSON.stringify(meta), sourceId); return next;
}
export interface Verdict { ok: boolean; reason?: string }
/** may this source's clip go to (channelId, platform)? `explicit` = the owner picked this destination in Distribute. */
export function sourceAllows(store: Store, sourceId: number | null, channelId: number | null, platform: string, explicit = false): Verdict {
  if (!sourceId) return { ok: true };
  const own = store.get<{ channel_id: number | null }>('SELECT channel_id FROM sources WHERE id=?', sourceId); if (!own) return { ok: true };
  if (!hasSourcePolicy(store, sourceId)) return { ok: true }; // never configured = unrestricted (legacy behaviour)
  const pol = getSourcePolicy(store, sourceId); const ownId = own.channel_id ?? mainChannel(store).id; const ch = channelId ?? ownId;
  if (ch === ownId) return pol.skipOwn ? { ok: false, reason: 'source policy: is source ki clips apne channel par nahi jaani (sirf mapped channels)' } : { ok: true };
  if (pol.mode === 'own_only') return { ok: false, reason: 'source policy: ye source sirf apne channel par upload ho sakta hai (exclusive)' };
  if (explicit || store.get('SELECT 1 FROM source_destinations WHERE source_id=? AND channel_id=? AND platform=? AND enabled=1', sourceId, ch, platform)) return { ok: true };
  return { ok: false, reason: 'source policy: is channel ki permission is source ko nahi di gayi' };
}
export const sourceOfClip = (store: Store, clipId: number): number | null => store.get<{ sid: number | null }>('SELECT v.source_id sid FROM clips c JOIN candidates k ON k.id=c.candidate_id JOIN videos v ON v.id=k.video_id WHERE c.id=?', clipId)?.sid ?? null;
