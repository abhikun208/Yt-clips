import type { Store } from '../db.ts';
import { shortHash } from '../util/hash.ts';
import type { Moment } from './moment-detector.ts';

/** Persist every discovered moment (all tiers, so the UI can show why something was not used). Re-analysis replaces the old rows of that video; rows linked to a rendered candidate are kept. */
export function persistMoments(store: Store, videoId: number, moments: Moment[], link: Map<Moment, { candidateFp: string; origin: 'moment' | 'legacy' }>): number {
  let n = 0;
  store.tx(() => {
    store.exec(`DELETE FROM moments WHERE video_id=? AND (candidate_id IS NULL OR candidate_id IN (SELECT id FROM candidates WHERE video_id=? AND status<>'rendered'))`, videoId, videoId);
    for (const m of moments) {
      const l = link.get(m); const cid = l ? store.get<{ id: number }>('SELECT id FROM candidates WHERE fingerprint=?', l.candidateFp)?.id ?? null : null;
      const fp = shortHash(`${videoId}:mom:${Math.round(m.start * 10)}:${Math.round(m.end * 10)}`, 16);
      n += store.exec(`INSERT INTO moments(video_id, candidate_id, origin, start_sec, end_sec, peak_at, tier, score, confidence, pattern, context_complete, boundary, breakdown_json, missing_json, reasons_json, explanation, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET candidate_id=excluded.candidate_id, origin=excluded.origin, tier=excluded.tier, score=excluded.score, confidence=excluded.confidence, pattern=excluded.pattern, context_complete=excluded.context_complete, breakdown_json=excluded.breakdown_json, missing_json=excluded.missing_json, reasons_json=excluded.reasons_json, explanation=excluded.explanation`,
        videoId, cid, l?.origin ?? 'moment', m.start, m.end, m.peakAt, m.tier, m.score, m.confidence, m.pattern, m.contextComplete === null ? null : m.contextComplete ? 1 : 0, m.boundary, JSON.stringify(m.breakdown), JSON.stringify(m.missing), JSON.stringify(m.reasons), m.explanation, fp).changes;
    }
  });
  return n;
}

export interface EditorialResult { ok: boolean; applies: boolean; reasons: string[] }
/** Editorial QC (the second of the two QCs; technical QC is clips.qc_pass). Only clips whose candidate has a moment row are judged: older clips are unaffected. */
export function editorialQc(store: Store, clipId: number, opts: { conditionalNeedsReview?: boolean } = {}): EditorialResult {
  const r = store.get<{ tier: string; origin: string; context_complete: number | null; confidence: number; review: string }>(`SELECT m.tier, m.origin, m.context_complete, m.confidence, c.review FROM clips c JOIN moments m ON m.candidate_id=c.candidate_id WHERE c.id=? ORDER BY m.score DESC LIMIT 1`, clipId);
  if (!r) return { ok: true, applies: false, reasons: [] };
  const approved = r.review === 'approved'; const why: string[] = [];
  if (r.tier === 'REJECTED' && !approved) why.push('moment tier REJECTED (weak evidence)');
  if (r.context_complete === 0 && !approved) why.push('setup/payoff context incomplete');
  if (r.tier === 'CONDITIONAL' && r.origin === 'moment' && opts.conditionalNeedsReview !== false && !approved) why.push('CONDITIONAL moment needs owner approval');
  return { ok: why.length === 0, applies: true, reasons: why };
}

/** Counts for the Home card: only what is stored/measured (no estimates). */
export function momentsSummary(store: Store): { discovered: number; byTier: Record<string, number>; usedAsClips: number; processing: number; queued: number; readyClips: number; blockedByEditorial: number; lastAt: string | null } {
  const byTier: Record<string, number> = { EXCEPTIONAL: 0, STRONG: 0, CONDITIONAL: 0, REJECTED: 0 };
  for (const r of store.all<{ tier: string; n: number }>('SELECT tier, count(*) n FROM moments GROUP BY tier')) byTier[r.tier] = r.n;
  const n = (sql: string) => store.get<{ n: number }>(sql)?.n ?? 0;
  const ready = store.all<{ id: number }>(`SELECT id FROM clips WHERE qc_pass=1 AND edited_path IS NOT NULL AND review<>'rejected'`);
  const blocked = ready.filter((c) => !editorialQc(store, c.id).ok).length;
  return { discovered: Object.values(byTier).reduce((a, b) => a + b, 0), byTier, usedAsClips: n('SELECT count(*) n FROM moments WHERE candidate_id IS NOT NULL'), processing: n(`SELECT count(*) n FROM jobs WHERE state='RUNNING'`), queued: n(`SELECT count(*) n FROM jobs WHERE state IN ('PENDING','RETRY')`), readyClips: ready.length - blocked, blockedByEditorial: blocked, lastAt: store.get<{ t: string | null }>('SELECT max(created_at) t FROM moments')?.t ?? null };
}
