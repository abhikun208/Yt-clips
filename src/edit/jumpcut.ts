import type { Interval } from '../analysis/signals.ts';
import type { Cue } from '../analysis/transcript.ts';

/** Dead-air removal. Silences (clip-relative seconds) longer than `minSilence` are shortened to `keep` seconds of pause; nothing else is touched. */
export interface CutPlan { removed: Interval[]; keep: Interval[]; saved: number }

export function planCuts(silence: Interval[], duration: number, o: { minSilence?: number; keep?: number; edge?: number; maxFrac?: number; minClipSec?: number } = {}): CutPlan | null {
  const minSil = o.minSilence ?? 0.55, keep = o.keep ?? 0.18, edge = o.edge ?? 0.8, maxFrac = o.maxFrac ?? 0.25;
  if (duration < (o.minClipSec ?? 8)) return null;
  let removed: Interval[] = [];
  for (const s of [...silence].sort((a, b) => a.start - b.start)) {
    const a = Math.max(s.start, edge) + keep / 2, b = Math.min(s.end, duration - edge) - keep / 2;
    if (s.end - s.start >= minSil && b - a >= 0.12) removed.push({ start: +a.toFixed(3), end: +b.toFixed(3) });
  }
  let total = removed.reduce((x, r) => x + r.end - r.start, 0);
  if (total > duration * maxFrac) { // over budget: shrink every cut proportionally (longer pauses are kept)
    const f = (duration * maxFrac) / total;
    removed = removed.map((r) => { const mid = (r.start + r.end) / 2, half = ((r.end - r.start) * f) / 2; return { start: +(mid - half).toFixed(3), end: +(mid + half).toFixed(3) }; }).filter((r) => r.end - r.start >= 0.12);
    total = removed.reduce((x, r) => x + r.end - r.start, 0);
  }
  if (!removed.length) return null;
  const keepSeg: Interval[] = []; let cur = 0;
  for (const r of removed) { if (r.start > cur) keepSeg.push({ start: cur, end: r.start }); cur = r.end; }
  if (cur < duration) keepSeg.push({ start: cur, end: duration });
  return { removed, keep: keepSeg, saved: +total.toFixed(3) };
}

/** Original clip time -> time after cuts (times inside a removed span collapse to the cut point). */
export function mapCutTime(t: number, p: CutPlan): number {
  let out = t;
  for (const r of p.removed) { if (t >= r.end) out -= r.end - r.start; else if (t > r.start) out -= t - r.start; }
  return out;
}
/** Re-time cues (absolute source time) after cuts. Words entirely inside a removed span are dropped. */
export function remapCuesCuts(cues: Cue[], clipStart: number, p: CutPlan): Cue[] {
  const f = (t: number) => clipStart + mapCutTime(t - clipStart, p);
  const inside = (a: number, b: number) => p.removed.some((r) => a - clipStart >= r.start && b - clipStart <= r.end);
  return cues.map((c) => ({ ...c, start: f(c.start), end: Math.max(f(c.start) + 0.05, f(c.end)), words: c.words?.filter((w) => !inside(w.start, w.end)).map((w) => ({ ...w, start: f(w.start), end: Math.max(f(w.start) + 0.03, f(w.end)) })) }));
}
/** select/aselect graph: both streams drop the same time spans, so A/V stay locked. */
export function cutFilter(p: CutPlan, hasAudio: boolean): string {
  const expr = p.removed.map((r) => `between(t\\,${r.start.toFixed(3)}\\,${r.end.toFixed(3)})`).join('+');
  const v = `[0:v]select='not(${expr})',setpts=N/FRAME_RATE/TB[v]`;
  return hasAudio ? `${v};[0:a]aselect='not(${expr})',asetpts=N/SR/TB,afade=t=in:st=0:d=0.01[a]` : v;
}
