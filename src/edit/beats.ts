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

/** Close-up "inserts" simulated from the clip's OWN footage (no stock, no copyright): a held +16% crop around each strong moment, eased in/out over 0.12 s. At most `max`, >= 4 s apart, never at the edges; none for clips under 10 s. */
export interface Closeup { start: number; end: number }
export function planCloseups(peaks: number[], duration: number, o: { max?: number; spacing?: number; lead?: number; hold?: number } = {}): Closeup[] {
  if (duration < 10) return []; const max = o.max ?? 2, spacing = o.spacing ?? 4, lead = o.lead ?? 0.3, hold = o.hold ?? 1.6; const out: Closeup[] = [];
  for (const t of peaks) { const a = Math.max(0.6, t - lead), b = Math.min(duration - 0.6, t + hold); if (b - a < 0.9) continue; if (out.length >= max) break; if (out.every((c) => a - c.end >= spacing - hold || Math.abs(c.start - a) >= spacing + hold)) out.push({ start: +a.toFixed(2), end: +b.toFixed(2) }); }
  return out;
}
/** ffmpeg zoompan z-expression: slow push-in (optional), a short triangular punch (+6%) at each time, and held close-up windows (+16%). */
export function zoomExpr(frames: number, fps: number, push: boolean, punch: number[], closeups: Closeup[] = []): string {
  const base = push ? `1.0+0.12*on/${frames}` : '1.0';
  const pulses = punch.map((t) => `0.06*max(0,1-abs(on/${fps}-${t.toFixed(2)})/0.2)`).join('+');
  const holds = closeups.map((c) => `0.16*clip(min((on/${fps}-${c.start.toFixed(2)})/0.12,(${c.end.toFixed(2)}-on/${fps})/0.12),0,1)`).join('+');
  return `min(${base}${pulses ? '+' + pulses : ''}${holds ? '+' + holds : ''},${holds ? '1.3' : '1.25'})`;
}
