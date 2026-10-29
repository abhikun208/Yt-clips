import { existsSync, copyFileSync } from 'node:fs';
import type { Store } from '../db.ts';
import { run } from '../util/proc.ts';

export type ClaimKind = 'audio' | 'visual' | 'both' | 'other';
export interface Range { from: number; to: number }
export const PAUSE_AFTER = 3;

/** Normalise owner-typed ranges: sorted, clamped, merged, max 20. Throws on garbage. */
export function cleanRanges(raw: unknown, durationSec?: number): Range[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('invalid: ranges must be a list (max 20)');
  const rs = raw.map((r) => { const a = Number((r as Range)?.from), b = Number((r as Range)?.to); if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) throw new Error('invalid: each range needs from < to (seconds)'); return { from: a, to: durationSec ? Math.min(b, durationSec) : b }; }).filter((r) => r.to > r.from).sort((x, y) => x.from - y.from);
  const out: Range[] = [];
  for (const r of rs) { const l = out[out.length - 1]; if (l && r.from <= l.to) l.to = Math.max(l.to, r.to); else out.push({ ...r }); }
  return out;
}

/** ffmpeg args that MUTE (audio claim) or CUT (visual/both claim) the ranges the platform itself reported. Honest fix: removes the claimed segment, nothing else. */
export function fixArgs(src: string, dst: string, kind: ClaimKind, ranges: Range[]): string[] {
  if (kind === 'audio') {
    const af = ranges.map((r) => `volume=enable='between(t,${r.from},${r.to})':volume=0`).join(',');
    return ['-y', '-i', src, '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '160k', dst];
  }
  const keep = ranges.map((r) => `between(t,${r.from},${r.to})`).join('+');
  return ['-y', '-i', src, '-vf', `select='not(${keep})',setpts=N/FRAME_RATE/TB`, '-af', `aselect='not(${keep})',asetpts=N/SR/TB`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', dst];
}

export interface ClaimResult { claimId: number; sourceId: number | null; sourceClaims: number; sourcePaused: boolean; newClipId: number | null; note: string }

/** Owner reports a claim they saw in Studio (API cannot expose Content ID). We reject the old clip, optionally build a fixed variant, and count per source. */
export async function recordClaim(store: Store, clipId: number, b: { kind: ClaimKind; ranges?: unknown; note?: string }): Promise<ClaimResult> {
  if (!['audio', 'visual', 'both', 'other'].includes(b.kind)) throw new Error('invalid: kind must be audio|visual|both|other');
  const c = store.get<{ id: number; candidate_id: number; output_id: string; edited_path: string | null; thumbnail_path: string | null; metadata_json: string | null; variant: number; source_id: number | null; duration: number | null }>(
    `SELECT c.id, c.candidate_id, c.output_id, c.edited_path, c.thumbnail_path, c.metadata_json, c.variant, v.source_id, (ca.end_sec - ca.start_sec) AS duration FROM clips c JOIN candidates ca ON ca.id=c.candidate_id JOIN videos v ON v.id=ca.video_id WHERE c.id=?`, clipId);
  if (!c) throw new Error('not found: clip');
  const ranges = cleanRanges(b.ranges, c.duration ?? undefined);
  const note = String(b.note ?? '').slice(0, 300);
  const claimId = store.exec('INSERT INTO claims(clip_id, source_id, kind, ranges_json, note) VALUES (?,?,?,?,?)', clipId, c.source_id, b.kind, JSON.stringify(ranges), note).lastId;
  store.exec(`UPDATE clips SET review='rejected', review_note=? WHERE id=?`, `claim (${b.kind}) ${note}`.trim(), clipId);
  let newClipId: number | null = null; let msg = 'clip reject kiya'; const made: string[] = [];
  if (ranges.length && c.edited_path && existsSync(c.edited_path) && b.kind !== 'other') {
    for (const k of b.kind === 'both' ? (['audio', 'visual'] as const) : ([b.kind] as const)) { // 'both' = two variants: A muted, B cut — the owner picks the one that passes
      const dst = c.edited_path.replace(/\.mp4$/, `.fx${claimId}${k[0]}.mp4`);
      const r = await run('ffmpeg', fixArgs(c.edited_path, dst, k, ranges), { timeoutMs: 10 * 60_000 }).catch(() => null);
      if (r && r.code === 0 && existsSync(dst)) {
        let thumb: string | null = null; if (c.thumbnail_path && existsSync(c.thumbnail_path)) { thumb = c.thumbnail_path.replace(/(\.\w+)$/, `.fx${claimId}${k[0]}$1`); copyFileSync(c.thumbnail_path, thumb); }
        const id = store.exec(`INSERT INTO clips(candidate_id, output_id, edited_path, thumbnail_path, metadata_json, variant, review, state) VALUES (?,?,?,?,?,?, 'pending', 'RENDERED')`, c.candidate_id, `${c.output_id}-fx${claimId}${k[0]}`, dst, thumb, c.metadata_json, c.variant + 1).lastId;
        newClipId ??= id; made.push(k === 'audio' ? 'mute' : 'cut');
      }
    }
    msg = made.length ? `naya variant (${made.join(' + ')}) review mein` : 'ffmpeg fix fail hua — clip reject hi raha';
  }
  let sourceClaims = 0, paused = false;
  if (c.source_id) {
    sourceClaims = store.get<{ n: number }>('SELECT count(*) n FROM claims WHERE source_id=?', c.source_id)?.n ?? 0;
    if (sourceClaims >= PAUSE_AFTER) { store.exec(`UPDATE sources SET status='paused' WHERE id=? AND status='active'`, c.source_id); paused = true; msg += ` · is source par ${sourceClaims} claims: auto-poll pause (owner resume kar sakta hai)`; }
  }
  return { claimId, sourceId: c.source_id, sourceClaims, sourcePaused: paused, newClipId, note: msg };
}

/** 1–10 source safety score: starts 10, −3 per claim, +1 per 5 clips that went through without one. <4 = high risk. A checklist signal for the owner, not a legal judgement. */
export const reliability = (claims: number, clips: number) => Math.max(1, Math.min(10, 10 - 3 * claims + Math.floor(Math.max(0, clips - claims) / 5)));

export function claimSummary(store: Store): { bySource: { source_id: number; title: string | null; claims: number; status: string; score: number; highRisk: boolean }[]; recent: unknown[] } {
  return {
    bySource: store.all<{ source_id: number; title: string | null; claims: number; status: string; clips: number }>(`SELECT s.id source_id, s.title, count(DISTINCT c.id) claims, s.status, (SELECT count(*) FROM clips k JOIN candidates ca ON ca.id=k.candidate_id JOIN videos v ON v.id=ca.video_id WHERE v.source_id=s.id) clips FROM claims c JOIN sources s ON s.id=c.source_id GROUP BY s.id ORDER BY claims DESC LIMIT 50`).map((r) => { const score = reliability(r.claims, r.clips); return { ...r, score, highRisk: score < 4 }; }),
    recent: store.all(`SELECT id, clip_id, source_id, kind, ranges_json, note, created_at FROM claims ORDER BY id DESC LIMIT 30`),
  };
}
