import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, which } from '../util/proc.ts';
import type { Series } from './external.ts';

/**
 * Killfeed activity signal via OCR (tesseract, optional). Samples ONE screen region (default: top-right where Free Fire / BGMI show kill
 * lines) every `step` seconds, OCRs it, and counts lines that were NOT in the previous sample = "something just happened".
 * Heuristic: it detects feed ACTIVITY, not who killed whom, and it was only validated on synthetic text frames (no real game footage).
 * Cost: one tesseract call per sample, so it is opt-in (channel config `killfeed`) and capped by maxSamples.
 */
export interface Region { x: number; y: number; w: number; h: number }
export const DEFAULT_REGION: Region = { x: 0.62, y: 0.04, w: 0.36, h: 0.3 };
export const killfeedAvailable = () => which('tesseract');

/** Distinct-looking lines in one OCR dump (alnum >= 4 chars, normalised). */
export function ocrLines(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]/g, ' ').replace(/\s+/g, ' ').trim()).filter((l) => (l.match(/[a-z0-9ऀ-ॿ]/g) ?? []).length >= 4))];
}
/** New-line events per sample -> Series (0..1, robust-scaled like the chat series). */
export function killfeedSeries(samples: string[][], step: number, duration: number, bucket = 5): Series | null {
  const events: number[] = []; let prev = new Set<string>(samples[0] ?? []); // first sample = baseline (static HUD text is not an event)
  samples.forEach((lines, i) => { if (i === 0) return; const cur = new Set(lines); for (const l of cur) if (![...prev].some((p) => similar(p, l))) events.push(i * step); prev = cur; });
  if (events.length < 2) return null;
  const n = Math.ceil(duration / bucket); const c = new Array<number>(n).fill(0); for (const t of events) { const i = Math.floor(t / bucket); if (i >= 0 && i < n) c[i]!++; }
  const sorted = [...c].sort((a, b) => a - b); const med = sorted[Math.floor(n / 2)]!, hi = Math.max(1, sorted[Math.min(n - 1, Math.floor(n * 0.95))]!, Math.max(...c) * 0.6);
  return { name: 'killfeed', step: bucket, values: c.map((x) => Math.max(0, Math.min(1, (x - med) / Math.max(1, hi - med)))) };
}
// OCR jitters by a character or two between frames: treat lines sharing >=80% of characters as the same line.
function similar(a: string, b: string): boolean { if (a === b) return true; const [s, l] = a.length < b.length ? [a, b] : [b, a]; if (s.length < 4 || l.length - s.length > 4) return false; let m = 0; for (let i = 0, j = 0; i < s.length && j < l.length; j++) if (s[i] === l[j]) { i++; m++; } return m / l.length >= 0.8; }

export async function scanKillfeed(video: string, duration: number, tmp: string, o: { region?: Region; step?: number; maxSamples?: number } = {}): Promise<Series | null> {
  if (!(await killfeedAvailable())) return null;
  const r = o.region ?? DEFAULT_REGION; const maxSamples = o.maxSamples ?? 2400; const step = Math.max(o.step ?? 2, duration / maxSamples);
  const dir = join(tmp, `kf_${Date.now()}`); mkdirSync(dir, { recursive: true });
  try {
    const vf = `fps=1/${step.toFixed(3)},crop=iw*${r.w}:ih*${r.h}:iw*${r.x}:ih*${r.y},scale=iw*2:-2:flags=lanczos,format=gray,eq=contrast=1.6`;
    const f = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-an', '-vf', vf, join(dir, 'f_%06d.png')], { timeoutMs: 60 * 60_000 }); if (f.code !== 0) return null;
    const files = readdirSync(dir).filter((x) => x.endsWith('.png')).sort(); const samples: string[][] = new Array(files.length);
    let next = 0; await Promise.all([0, 1].map(async () => { for (;;) { const i = next++; if (i >= files.length) return; const t = await run('tesseract', [join(dir, files[i]!), 'stdout', '--psm', '6'], { timeoutMs: 60_000 }).catch(() => null); samples[i] = t && t.code === 0 ? ocrLines(t.stdout) : []; } }));
    return killfeedSeries(samples, step, duration);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
