/**
 * Pacing: a visual "beat" (punch-zoom, and flash cuts on the first two) at least every N seconds so the clip never sits still.
 *   fast = every 2-4 s, medium = every 4-6 s, relaxed = at most 10 s apart, off = only real audio peaks.
 * Audio-peak beats are kept; gaps larger than the maximum are filled with extra beats spaced inside the allowed window.
 */
export type Pace = 'fast' | 'medium' | 'relaxed' | 'off';
export const PACES: Record<Exclude<Pace, 'off'>, { min: number; max: number }> = { fast: { min: 2, max: 4 }, medium: { min: 4, max: 6 }, relaxed: { min: 6, max: 10 } };
export const isPace = (x: unknown): x is Pace => x === 'fast' || x === 'medium' || x === 'relaxed' || x === 'off';

export function fillPace(punch: number[], duration: number, pace: Pace): number[] {
  if (pace === 'off' || duration < 4) return punch;
  const { min, max } = PACES[pace]; const out = [...punch].filter((t) => t > 0.4 && t < duration - 0.5).sort((a, b) => a - b);
  const edge = duration - 0.6; let prev = 0; const res: number[] = []; let k = 0;
  const pts = [...out, Infinity];
  for (const next of pts) {
    while ((Math.min(next, edge)) - prev > max) { const step = k++ % 2 ? (min + max) / 2 + 0.3 : (min + max) / 2 - 0.3; prev = +(prev + Math.min(max - 0.2, Math.max(min, step))).toFixed(2); if (prev >= edge) break; res.push(prev); }
    if (next !== Infinity) { res.push(next); prev = next; }
  }
  return [...new Set(res)].sort((a, b) => a - b);
}
