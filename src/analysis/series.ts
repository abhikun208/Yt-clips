import type { Sentence } from './textsignals.ts';

export interface PartSpan { start: number; end: number }
export interface SeriesParams { minSec: number; maxSec: number; partSec: number; maxParts: number; hi: number }

/**
 * "Part 1/2/3": when a strong moment is really a longer story, continue past the single clip through the sentences that follow
 * (no long gap = same story) and cut the whole span into balanced parts that each start and end on a sentence boundary.
 * Returns null when the story is not clearly longer than one normal clip (then the single clip stays as is).
 */
export function planSeries(start: number, end: number, sents: Sentence[], p: SeriesParams): PartSpan[] | null {
  const after = sents.filter((s) => s.start >= end - 0.4).sort((a, b) => a.start - b.start);
  let ext = end; let lastEnd = end;
  for (const s of after) { if (s.start - lastEnd > 2.5) break; if (s.end - start > p.partSec * p.maxParts || s.end > p.hi) break; ext = s.end; lastEnd = s.end; }
  const total = ext - start; if (total < p.maxSec * 1.25) return null;
  const n = Math.max(2, Math.min(p.maxParts, Math.round(total / p.partSec))); const target = total / n;
  const ends = sents.map((s) => s.end).filter((t) => t > start + p.minSec && t < ext - p.minSec);
  const spans: PartSpan[] = []; let prev = start;
  for (let i = 1; i < n; i++) {
    const want = start + i * target; let best: number | null = null; let bd = 8;
    for (const t of ends) { const d = Math.abs(t - want); if (d < bd && t - prev >= p.minSec) { bd = d; best = t; } }
    const cut = best ?? want; spans.push({ start: prev, end: +(cut + 0.12).toFixed(2) }); prev = +(cut + 0.12).toFixed(2);
  }
  spans.push({ start: prev, end: +ext.toFixed(2) });
  return spans.every((s) => s.end - s.start >= p.minSec && s.end - s.start <= p.maxSec + 6) ? spans : null;
}
