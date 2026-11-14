import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../util/proc.ts';

/**
 * Facecam finder WITHOUT any AI model (works on Termux). A streamer's facecam is a rectangle stuck in one corner of the game picture: its two INNER edges
 * (the side facing the game and the side facing the centre) are straight lines with a hard brightness step that stay at the same place in EVERY frame, while
 * normal gameplay does not keep a straight step edge at one fixed spot. For each corner we search the box size that maximises the weakest-frame edge strength.
 * confidence = weakest-frame score / 0.10 (clamped 0..1). Below `minConfidence` (default 0.7) the answer is "none" and the caller keeps its normal layout.
 * Tuned on synthetic frames only - real footage UNVERIFIED (tune via cfg.edit.facecamMinConfidence).
 */
export interface FacecamGuess { zone: 'tl' | 'tr' | 'bl' | 'br' | null; confidence: number; rect: { x: number; y: number; w: number; h: number } | null; scores: Record<string, number>; frames: number }
const W = 192, H = 108;

/** pure core: gray frames (W*H bytes each) -> best box per corner */
export function findFacecam(frames: Uint8Array[], minConfidence = 0.7): FacecamGuess {
  const corners = ['tl', 'tr', 'bl', 'br'] as const; const scores: Record<string, number> = {}; let best: { z: typeof corners[number]; s: number; x0: number; y0: number; x1: number; y1: number } | null = null;
  if (frames.length < 3) return { zone: null, confidence: 0, rect: null, scores, frames: frames.length };
  const px = (f: Uint8Array, x: number, y: number): number => f[y * W + x]!;
  // step-edge strength of a vertical line at column x between rows [ya,yb): |mean(x+1..x+2) - mean(x-2..x-1)|, minus the same measure 4 columns away (so textured areas do not count)
  const vEdge = (f: Uint8Array, x: number, ya: number, yb: number, o = 0): number => { const e = (xx: number): number => { let s = 0; for (let y = ya; y < yb; y++) s += Math.abs((px(f, xx + 1, y) + px(f, xx + 2, y)) / 2 - (px(f, xx - 1, y) + px(f, xx - 2, y)) / 2); return s / (yb - ya) / 255; }; return e(x) - 0.6 * (o ? e(x + o * 5) : Math.max(e(x - 5), e(x + 5))); };
  const hEdge = (f: Uint8Array, y: number, xa: number, xb: number, o = 0): number => { const e = (yy: number): number => { let s = 0; for (let x = xa; x < xb; x++) s += Math.abs((px(f, x, yy + 1) + px(f, x, yy + 2)) / 2 - (px(f, x, yy - 1) + px(f, x, yy - 2)) / 2); return s / (xb - xa) / 255; }; return e(y) - 0.6 * (o ? e(y + o * 5) : Math.max(e(y - 5), e(y + 5))); };
  for (const z of corners) {
    const top = z[0] === 't', left = z[1] === 'l'; let zb = { s: 0, x0: 0, y0: 0, x1: 0, y1: 0 }; const cands: { s: number; x0: number; y0: number; x1: number; y1: number }[] = [];
    for (let bw = 22; bw <= 66; bw += 2) for (let bh = 18; bh <= 60; bh += 2) { // box size in the 192x108 frame (11%..34% wide, 17%..55% tall)
      const x0 = left ? 0 : W - bw, x1 = left ? bw : W, y0 = top ? 0 : H - bh, y1 = top ? bh : H;
      const ex = left ? x1 : x0, ey = top ? y1 : y0; // the two inner edges
      const per: number[] = []; for (const f of frames) { const cx = Math.min(W - 4, Math.max(3, ex)), cy = Math.min(H - 4, Math.max(3, ey));
        const v = vEdge(f, cx, y0 + 1, y1 - 1, left ? 1 : -1), h = hEdge(f, cy, x0 + 1, x1 - 1, top ? 1 : -1); // only the OUTSIDE neighbour counts as 'texture'
        // a real box ENDS: the same lines must be quiet just beyond the box corner (a line that runs on is a game/UI structure, not a facecam)
        const vb = top ? [y1 + 2, y1 + 10] : [y0 - 10, y0 - 2], hb = left ? [x1 + 2, x1 + 10] : [x0 - 10, x0 - 2];
        const vOut = vb[0]! >= 1 && vb[1]! <= H - 1 ? Math.max(0, vEdge(f, cx, vb[0]!, vb[1]!)) : 0, hOut = hb[0]! >= 1 && hb[1]! <= W - 1 ? Math.max(0, hEdge(f, cy, hb[0]!, hb[1]!)) : 0;
        per.push(Math.min(v - vOut * 1.5, h - hOut * 1.5)); if (per.filter((x) => x <= 0).length >= 2) break; }
      per.sort((a, b) => a - b); const weakest = per.length >= 2 ? per[1]! : 0; // the box must hold in all frames but one (a scene flash may hide it once)
      if (weakest > zb.s) zb = { s: weakest, x0, y0, x1, y1 }; if (weakest > 0.02) cands.push({ s: weakest, x0, y0, x1, y1 });
    }
    { const big = cands.filter((c) => c.s >= zb.s * 0.85).sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0]; if (big) zb = big; } // equally strong lines inside the cam picture are not its border: take the OUTER box
    scores[z] = Math.round(Math.min(1, zb.s / 0.10) * 100) / 100; if (!best || zb.s > best.s) best = { z, s: zb.s, ...zb };
  }
  const conf = best ? Math.min(1, best.s / 0.10) : 0; const second = Object.entries(scores).filter(([k]) => k !== best?.z).reduce((a, [, v]) => Math.max(a, v), 0);
  if (!best || conf < minConfidence || conf - second < 0.15) return { zone: null, confidence: Math.round(conf * 100) / 100, rect: null, scores, frames: frames.length }; // not clear: caller keeps its normal layout
  const inset = 1; return { zone: best.z, confidence: Math.round(conf * 100) / 100, scores, frames: frames.length, rect: { x: (best.x0 + (best.z[1] === 'l' ? 0 : inset)) / W, y: (best.y0 + (best.z[0] === 't' ? 0 : inset)) / H, w: (best.x1 - best.x0 - inset) / W, h: (best.y1 - best.y0 - inset) / H } };
}

/** sample 6 frames across the video (cheap: 6 tiny 192x108 grays) and run the finder. Never throws: any failure = "none". */
export async function detectFacecam(path: string, duration: number, minConfidence = 0.7): Promise<FacecamGuess & { note?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ytc-fc-')); const frames: Uint8Array[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      const out = join(dir, `f${i}.raw`); const t = Math.max(0, duration * (0.1 + 0.16 * i));
      const r = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-ss', t.toFixed(2), '-i', path, '-frames:v', '1', '-an', '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-y', out], { timeoutMs: 45_000 }).catch(() => null);
      if (!r || r.code !== 0) continue; try { const b = readFileSync(out); if (b.length === W * H) frames.push(new Uint8Array(b)); } catch { /* skip frame */ }
    }
    if (frames.length < 4) return { zone: null, confidence: 0, rect: null, scores: {}, frames: frames.length, note: 'frames padhe nahi ja sake' };
    return findFacecam(frames, minConfidence);
  } catch (e) { return { zone: null, confidence: 0, rect: null, scores: {}, frames: frames.length, note: (e as Error).message }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
