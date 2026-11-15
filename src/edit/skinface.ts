import { spawnSync } from 'node:child_process';

/**
 * No-OpenCV fallback (Termux): finds where a person's face/head sits horizontally using only ffmpeg.
 * Samples small frames, builds a skin-tone mask (YCbCr rule), looks at the upper 65% of the picture
 * (faces, not hands/legs) and returns the stable horizontal centre (0..1), or undefined when there is
 * no consistent skin blob (gameplay, screen recording, scenery, face-less video).
 * A heuristic: tolerates lighting, not make-up/skin edge cases -> callers must treat it as a hint only.
 */
const W = 96, H = 54;
export function skinBlobs(frame: Buffer): { cx: number; mass: number; compact: number } | null {
  const cols = new Float64Array(W); let n = 0; let sx = 0, sy = 0, sxx = 0, syy = 0; const lim = Math.floor(H * 0.65);
  for (let y = 0; y < lim; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3; const r = frame[i]!, g = frame[i + 1]!, b = frame[i + 2]!;
    const Y = 0.299 * r + 0.587 * g + 0.114 * b, cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
    if (Y > 50 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 && r > g && r > b) { cols[x]! += 1; n++; sx += x; sy += y; sxx += x * x; syy += y * y; }
  }
  const tot = W * lim; if (n < tot * 0.012 || n > tot * 0.55) return null; // too little = nobody; too much = a skin/orange coloured background
  const mx = sx / n, my = sy / n; const vx = sxx / n - mx * mx, vy = syy / n - my * my; // blob must be compact (a head), not a stripe
  const compact = Math.sqrt(vx + vy) / W; if (Math.sqrt(vx) / W > 0.17 || compact > 0.25) return null;
  return { cx: mx / W, mass: n / tot, compact };
}
export function skinFaceCenter(path: string, startSec = 0, durSec = 60, samples = 12, crop?: { x: number; y: number; w: number; h: number }): number | undefined {
  const fps = Math.max(0.05, samples / Math.max(4, durSec));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(startSec), '-t', String(durSec), '-i', path, '-vf', `${crop ? `crop=iw*${crop.w.toFixed(4)}:ih*${crop.h.toFixed(4)}:iw*${crop.x.toFixed(4)}:ih*${crop.y.toFixed(4)},` : ''}fps=${fps.toFixed(4)},scale=${W}:${H}:flags=area`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-frames:v', String(samples), '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (r.status !== 0 || !r.stdout?.length) return undefined;
  const sz = W * H * 3; const hits: number[] = []; let frames = 0;
  for (let o = 0; o + sz <= r.stdout.length; o += sz) { frames++; const b = skinBlobs(r.stdout.subarray(o, o + sz)); if (b) hits.push(b.cx); }
  if (frames < 3 || hits.length < frames * 0.6) return undefined;
  hits.sort((a, b) => a - b); const med = hits[hits.length >> 1]!; const spread = hits.filter((h) => Math.abs(h - med) < 0.18).length;
  return spread >= frames * 0.6 ? Math.min(0.9, Math.max(0.1, med)) : undefined; // stays put in most frames = a person in a fixed place
}
