import { normalizeEnergy, type Series } from '../analysis/signals.ts';

/**
 * Pick emphasis moments from the clip's OWN audio energy (loud transients), for punch-zoom pulses.
 * Local maxima above `min` (0..1 normalised), spaced >= `spacing` s apart, away from the edges, at most `max`. Strongest first, returned in time order.
 */
export function pickPeaks(s: Series, o: { min?: number; spacing?: number; max?: number; margin?: number; duration: number }): number[] {
  const min = o.min ?? 0.8, spacing = o.spacing ?? 1.5, max = o.max ?? 4, margin = o.margin ?? 0.5;
  const v = normalizeEnergy(s); const cands: { t: number; e: number }[] = [];
  for (let i = 0; i < v.length; i++) {
    const e = v[i]!; if (e < min) continue;
    if ((i > 0 && v[i - 1]! > e) || (i < v.length - 1 && v[i + 1]! > e)) continue;
    const t = i * s.step; if (t < margin || t > o.duration - margin) continue;
    cands.push({ t, e });
  }
  cands.sort((a, b) => b.e - a.e); const out: number[] = [];
  for (const c of cands) { if (out.length >= max) break; if (out.every((x) => Math.abs(x - c.t) >= spacing)) out.push(c.t); }
  return out.sort((a, b) => a - b);
}

/** ffmpeg zoompan z-expression: slow push-in (optional) plus a short triangular punch (+6%) at each time. */
export function zoomExpr(frames: number, fps: number, push: boolean, punch: number[]): string {
  const base = push ? `1.0+0.12*on/${frames}` : '1.0';
  const pulses = punch.map((t) => `0.06*max(0,1-abs(on/${fps}-${t.toFixed(2)})/0.2)`).join('+');
  return `min(${base}${pulses ? '+' + pulses : ''},1.25)`;
}
