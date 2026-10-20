import { run } from '../util/proc.ts';

export interface Interval { start: number; end: number }
export interface Series { step: number; values: number[] }

/** Silence intervals via ffmpeg silencedetect. Over the ENTIRE file. */
export async function detectSilence(path: string, noiseDb = -35, minDur = 0.6): Promise<Interval[]> {
  const r = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', path, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-'], { timeoutMs: 30 * 60_000 });
  return parseSilence(r.stderr);
}
export function parseSilence(stderr: string): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return out;
}

/** Scene change timestamps via scdet (frame-difference score). Downscaled to be cheap on mobile CPUs. */
export async function detectScenes(path: string, threshold = 12): Promise<number[]> {
  const r = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', path, '-an', '-vf', `fps=4,scale=320:-2,scdet=t=${threshold}:s=1`, '-f', 'null', '-'], { timeoutMs: 30 * 60_000 });
  return parseScenes(r.stderr);
}
export function parseScenes(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/lavfi\.scd\.time:\s*([\d.]+)/g)) out.push(Number(m[1]));
  for (const m of stderr.matchAll(/scd_time[=:]\s*([\d.]+)/g)) out.push(Number(m[1]));
  return [...new Set(out)].sort((a, b) => a - b);
}

/** RMS loudness series (dBFS) at fixed step across the whole file using astats via ametadata. */
export async function audioEnergy(path: string, step = 0.5): Promise<Series> {
  // asetnsamples groups into step-sized frames at 16kHz mono so astats reports per-frame RMS.
  const n = Math.round(16000 * step);
  const r = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', path, '-vn', '-ac', '1', '-ar', '16000',
    '-af', `asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'], { timeoutMs: 30 * 60_000 });
  return parseEnergy(r.stdout, step);
}
export function parseEnergy(out: string, step: number): Series {
  const values: number[] = [];
  for (const m of out.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf|inf|nan)/g)) {
    const v = Number(m[1]);
    values.push(Number.isFinite(v) ? v : -90);
  }
  return { step, values };
}

/** Black / freeze segments (useful for intro/outro cards and QC). */
export async function detectBlack(path: string): Promise<Interval[]> {
  const r = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', path, '-an', '-vf', 'fps=2,scale=160:-2,blackdetect=d=0.5:pix_th=0.12', '-f', 'null', '-'], { timeoutMs: 30 * 60_000 });
  const out: Interval[] = [];
  for (const m of r.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) out.push({ start: Number(m[1]), end: Number(m[2]) });
  return out;
}

/** Normalise dB energy to 0..1 relative to the file's own distribution (robust to loudness differences). */
export function normalizeEnergy(s: Series): number[] {
  const v = s.values.filter((x) => x > -89);
  if (v.length < 4) return s.values.map(() => 0);
  const sorted = [...v].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)]!;
  const hi = sorted[Math.floor(sorted.length * 0.98)]!;
  const span = Math.max(1, hi - lo);
  return s.values.map((x) => Math.max(0, Math.min(1, (x - lo) / span)));
}
