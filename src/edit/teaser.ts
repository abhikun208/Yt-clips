import { rmSync } from 'node:fs';
import { run } from '../util/proc.ts';
import { prependHook } from './hookintro.ts';

/**
 * Hook teaser: the payoff moment (already captioned, taken from the finished clip) plays for ~1.5 s at the very start, then the clip runs normally.
 * Pure re-use of the finished picture, so captions/title/layout match. Returns the added seconds (0 = skipped).
 */
export function teaserAt(o: { peakRel: number | null | undefined; outDur: number; len?: number }): number | null {
  const len = o.len ?? 1.5; const p = o.peakRel;
  if (p === null || p === undefined || !Number.isFinite(p)) return null;
  const at = p - 0.4; // start just before the peak so the reaction/payoff is heard
  return at >= 4 && at + len <= o.outDur - 1.5 ? +at.toFixed(2) : null; // the teaser must not be the opening or the very ending (it would repeat)
}
export async function prependTeaser(clipPath: string, at: number, o: { width: number; height: number; fps: number; len?: number; tmpDir: string }): Promise<number> {
  const len = o.len ?? 1.5; const tmp = `${o.tmpDir}/teaser_${Date.now()}.mp4`;
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-t', len.toFixed(2), '-i', clipPath, '-vf', `fade=t=in:d=0.08,fade=t=out:st=${(len - 0.12).toFixed(2)}:d=0.12`, '-af', `afade=t=in:d=0.05,afade=t=out:st=${(len - 0.15).toFixed(2)}:d=0.15`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', tmp], { timeoutMs: 120_000 });
  if (r.code !== 0) { rmSync(tmp, { force: true }); throw new Error(`teaser cut failed: ${r.stderr.slice(0, 160)}`); }
  try { return await prependHook(clipPath, tmp, { width: o.width, height: o.height, fps: o.fps, maxSec: len }); } finally { rmSync(tmp, { force: true }); }
}
