import type { Cue } from '../analysis/transcript.ts';

/** One slow-motion window [a,b] (seconds in the ORIGINAL clip) played at `rate` (<1 = slower). */
export interface Ramp { a: number; b: number; rate: number }

/** Plan a single slow-motion window around the strongest audio peak. Returns null when the clip is too short or has no peak (nothing is forced). */
export function planRamp(peak: number | undefined, duration: number, o: { rate?: number; pre?: number; post?: number; minClipSec?: number } = {}): Ramp | null {
  const rate = o.rate ?? 0.7, pre = o.pre ?? 0.4, post = o.post ?? 1.0;
  if (peak === undefined || duration < (o.minClipSec ?? 8)) return null;
  const a = Math.max(0.5, peak - pre), b = Math.min(duration - 0.5, peak + post);
  return b - a >= 0.6 ? { a, b, rate } : null;
}
export const rampedDuration = (d: number, r: Ramp) => d + (r.b - r.a) * (1 / r.rate - 1);
/** Original clip time -> time in the ramped clip. */
export function mapTime(t: number, r: Ramp): number {
  if (t <= r.a) return t; if (t >= r.b) return r.a + (r.b - r.a) / r.rate + (t - r.b); return r.a + (t - r.a) / r.rate;
}
/** Re-time cues (absolute source time) so captions stay in sync with the ramped clip. `clipStart` = clip start in the source. */
export function remapCues(cues: Cue[], clipStart: number, r: Ramp): Cue[] {
  const f = (t: number) => clipStart + mapTime(t - clipStart, r);
  return cues.map((c) => ({ ...c, start: f(c.start), end: f(c.end), words: c.words?.map((w) => ({ ...w, start: f(w.start), end: f(w.end) })) }));
}
/** ffmpeg args pieces: filter_complex producing [v]/[a] with the slow window (audio via atempo, pitch preserved). */
export function rampFilter(r: Ramp, hasAudio: boolean): string {
  const A = r.a.toFixed(3), B = r.b.toFixed(3), inv = (1 / r.rate).toFixed(4);
  const v = `[0:v]split=3[v0][v1][v2];[v0]trim=0:${A},setpts=PTS-STARTPTS[x0];[v1]trim=${A}:${B},setpts=(PTS-STARTPTS)*${inv}[x1];[v2]trim=start=${B},setpts=PTS-STARTPTS[x2];[x0][x1][x2]concat=n=3:v=1:a=0[v]`;
  if (!hasAudio) return v;
  return `${v};[0:a]asplit=3[a0][a1][a2];[a0]atrim=0:${A},asetpts=PTS-STARTPTS[y0];[a1]atrim=${A}:${B},asetpts=PTS-STARTPTS,atempo=${r.rate.toFixed(4)}[y1];[a2]atrim=start=${B},asetpts=PTS-STARTPTS[y2];[y0][y1][y2]concat=n=3:v=0:a=1[a]`;
}
