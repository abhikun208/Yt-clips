import type { Interval } from './signals.ts';

export interface Boundaries { introEnd: number; outroStart: number; reasons: string[] }

/**
 * Detect real intro/outro boundaries (not a fixed cut).
 * Intro: a black card/leading silence/first scene cut within introMaxSec — we pick the END of the earliest
 *        black-or-silent interval that starts near 0, else the first scene change inside the window if the
 *        opening is a short, visually-uniform segment, else 0.
 * Outro: a black/silent block that runs to (near) the end within outroMaxSec of the tail.
 * Owner overrides (introEnd/outroStart) always win.
 */
export function detectBoundaries(duration: number, o: {
  silence: Interval[]; black: Interval[]; scenes: number[]; introMaxSec: number; outroMaxSec: number;
  override?: { introEnd?: number; outroStart?: number };
}): Boundaries {
  const reasons: string[] = [];
  let introEnd = 0;
  let outroStart = duration;

  const lead = [...o.black, ...o.silence].filter((i) => i.start <= 1.5 && i.end <= o.introMaxSec).sort((a, b) => b.end - a.end)[0];
  if (lead) { introEnd = lead.end; reasons.push(`leading black/silent block until ${lead.end.toFixed(1)}s`); }
  else {
    const firstCut = o.scenes.find((t) => t >= 3 && t <= Math.min(o.introMaxSec, duration * 0.15));
    // Only treat as branded intro if there is a *single* early cut and then a clear stretch of content.
    if (firstCut !== undefined && o.scenes.filter((t) => t <= firstCut + 2).length === 1) {
      introEnd = firstCut; reasons.push(`short opening segment ending at scene cut ${firstCut.toFixed(1)}s`);
    }
  }

  const tail = [...o.black, ...o.silence].filter((i) => i.end >= duration - 1.5 && i.start >= duration - o.outroMaxSec).sort((a, b) => a.start - b.start)[0];
  if (tail) { outroStart = tail.start; reasons.push(`trailing black/silent block from ${tail.start.toFixed(1)}s`); }

  if (o.override?.introEnd !== undefined) { introEnd = o.override.introEnd; reasons.push('owner override introEnd'); }
  if (o.override?.outroStart !== undefined) { outroStart = o.override.outroStart; reasons.push('owner override outroStart'); }

  // Safety: never discard more than 40% of a video; keep the usable window sane.
  if (introEnd > duration * 0.4) { introEnd = 0; reasons.push('intro capped (would discard >40%)'); }
  if (outroStart < duration * 0.6) { outroStart = duration; reasons.push('outro capped (would discard >40%)'); }
  return { introEnd, outroStart, reasons };
}
