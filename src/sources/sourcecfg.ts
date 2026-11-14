import type { Config } from '../config.ts';

/**
 * Per-source (watched channel) settings, stored in sources.meta_json. Every field is optional: missing = the global default, so
 * existing sources behave exactly as before.
 *  perPoll        videos downloaded per check for THIS channel      (default: global youtube.maxPerPoll)
 *  checkMinutes   how often THIS channel is searched               (default: global; never faster than the global timer tick)
 *  scanDepth      how many of the latest videos one listing reads  (default 30, max 200)
 *  backlog        true = when no new video is waiting, OLD videos of the channel are processed too (default true)
 *  order          'newest' | 'oldest' - which waiting video goes first (default newest)
 *  maxDurationMin skip videos longer than this                    (default: global)
 */
export interface SourceSettings { perPoll: number; checkMinutes: number; scanDepth: number; backlog: boolean; order: 'newest' | 'oldest'; maxDurationMin: number }
const num = (v: unknown, lo: number, hi: number, d: number): number => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
export function sourceSettings(meta: Record<string, unknown> | null | undefined, cfg: Config): SourceSettings {
  const m = meta ?? {};
  return { perPoll: num(m.perPoll, 1, 20, cfg.youtube.maxPerPoll), checkMinutes: num(m.checkMinutes, 0, 10080, 0), scanDepth: num(m.scanDepth, 5, 200, 30), backlog: m.backlog !== false, order: m.order === 'oldest' ? 'oldest' : 'newest', maxDurationMin: num(m.maxDurationMin, 1, 1440, cfg.youtube.maxDurationMin) };
}
/** keep only known keys, validated (API input) */
export function cleanSettings(b: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if ('perPoll' in b) o.perPoll = num(b.perPoll, 1, 20, 1);
  if ('checkMinutes' in b) o.checkMinutes = num(b.checkMinutes, 0, 10080, 0);
  if ('scanDepth' in b) o.scanDepth = num(b.scanDepth, 5, 200, 30);
  if ('backlog' in b) o.backlog = b.backlog !== false;
  if ('order' in b) o.order = b.order === 'oldest' ? 'oldest' : 'newest';
  if ('maxDurationMin' in b) o.maxDurationMin = num(b.maxDurationMin, 1, 1440, 360);
  return o;
}

/** A download error that will never succeed by retrying: the video is skipped (with a plain reason) instead of blocking the queue. */
export function permanentReason(err: string): string | null {
  if (/members-only|join this channel|members only/i.test(err)) return 'members-only video (sirf channel members dekh sakte hain) - skip';
  if (/private video|this video is private/i.test(err)) return 'private video - skip';
  if (/has been removed|video unavailable|no longer available|account associated .* terminated|this video is not available|removed by the uploader/i.test(err)) return 'video hata diya gaya / unavailable - skip';
  if (/confirm your age|age.restricted|inappropriate for some users/i.test(err)) return 'age-restricted video (login/cookies chahiye) - skip';
  if (/not available in your country|blocked .* (country|copyright)|blocked it on copyright/i.test(err)) return 'is desh me / copyright se blocked - skip';
  return null;
}
/** Not started yet (premiere / upcoming live): try again later without using up an attempt. */
export const notYet = (err: string): boolean => /premieres? in|live event will begin|will begin in|upcoming/i.test(err);
