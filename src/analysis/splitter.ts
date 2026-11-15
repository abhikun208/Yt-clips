import type { Sentence } from './textsignals.ts';

/**
 * Narrative cut finder for "Part 1/2/3". Instead of cutting at equal times, every sentence end near the wanted
 * time is scored on how good a place it is to stop: a real pause after it, a scene change next to it, an open
 * ending (question / "lekin", "tabhi", "aage..." = cliffhanger) and NOT a dangling connector ("aur", "toh", "ki").
 * The best-scoring end wins; distance from the balanced time is a penalty so parts stay roughly even and <= maxSec.
 * Pure function: no I/O, no model.
 */
const OPEN = /(\?|\.\.\.|…)\s*$|\b(lekin|par|magar|tabhi|achanak|phir|aur phir|aage|dekhiye|dekho|suno|but|then|suddenly|wait|until|what happened)\b[^.!?]{0,40}$/i;
const DANGLE = /\b(aur|toh|to|ki|ke|ka|ko|se|me|mein|jo|kyunki|because|and|the|a|of)\s*$/i;
const CLOSE = /[.!।]\s*$/;

export interface CutScore { t: number; score: number; why: string[] }
export function scoreCut(i: number, sents: Sentence[], scenes: number[] = []): CutScore {
  const s = sents[i]!; const nxt = sents[i + 1]; const why: string[] = []; let sc = 0;
  const gap = nxt ? nxt.start - s.end : 1.5; if (gap >= 0.35) { sc += Math.min(1.5, gap) * 0.8; why.push(`pause ${gap.toFixed(1)}s`); }
  if (scenes.some((x) => Math.abs(x - s.end) < 0.8)) { sc += 1; why.push('scene change'); }
  if (OPEN.test(s.text.trim())) { sc += 1.2; why.push('open ending'); } else if (CLOSE.test(s.text.trim())) { sc += 0.5; why.push('natural stop'); }
  if (DANGLE.test(s.text.trim())) { sc -= 1.5; why.push('dangling word'); }
  return { t: s.end, score: sc, why };
}

export function chooseCuts(start: number, ext: number, n: number, sents: Sentence[], o: { minSec: number; maxSec: number; scenes?: number[] }): { cuts: number[]; reasons: string[] } | null {
  const total = ext - start; const target = total / n; const cuts: number[] = []; const reasons: string[] = []; let prev = start;
  const idx = sents.map((s, i) => ({ s, i })).filter((x) => x.s.end > start + o.minSec && x.s.end < ext - o.minSec);
  for (let k = 1; k < n; k++) {
    const want = start + k * target; let best: CutScore | null = null; let bv = -1e9;
    for (const { i } of idx) {
      const c = scoreCut(i, sents, o.scenes); const d = Math.abs(c.t - want);
      if (d > Math.max(10, target * 0.3) || c.t - prev < o.minSec || c.t - prev > o.maxSec || ext - c.t < o.minSec * (n - k)) continue;
      const v = c.score - d * 0.12; if (v > bv) { bv = v; best = c; }
    }
    if (!best) { const t = Math.min(want, prev + o.maxSec); cuts.push(t); reasons.push('even split (no sentence end nearby)'); prev = t; continue; }
    cuts.push(best.t); reasons.push(best.why.join(', ') || 'sentence end'); prev = best.t;
  }
  return { cuts, reasons };
}
