import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, which } from '../util/proc.ts';

/** Parse ffmpeg `idet` summary. Interlaced when combed frames are a real share of the frames it could classify. */
export function parseIdet(stderr: string): boolean {
  const m = /Multi frame detection:\s*TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)\s*Undetermined:\s*(\d+)/i.exec(stderr); if (!m) return false;
  const comb = Number(m[1]) + Number(m[2]), prog = Number(m[3]); return comb + prog >= 20 && comb > prog * 0.5;
}
/** Samples ~6 s from the middle of [start,end] of the ORIGINAL; TV/serial rips are often interlaced (flagged progressive) and show horizontal comb lines when cropped/upscaled. */
export async function isInterlaced(path: string, start: number, end: number): Promise<boolean> {
  const t = Math.max(0, start + (end - start) / 2 - 3);
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', t.toFixed(2), '-t', '6', '-i', path, '-an', '-vf', 'idet', '-f', 'null', '-'], { timeoutMs: 120_000 }).catch(() => null);
  return r ? parseIdet(r.stderr) : false;
}
/** Burned-in subtitles/lower-third text in the bottom band (OCR, optional tesseract). A centre 9:16 crop cuts such text in half, so the caller switches to fit-with-blur. */
export async function hasBurnedSubs(path: string, start: number, end: number, tmp: string): Promise<boolean> {
  if (!(await which('tesseract'))) return false; mkdirSync(tmp, { recursive: true }); let hits = 0; const n = 4; const tag = `bs_${Date.now()}`;
  for (let i = 0; i < n; i++) {
    const f = join(tmp, `${tag}_${i}.png`); const t = start + ((end - start) * (i + 0.5)) / n;
    try {
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'crop=iw:ih*0.2:0:ih*0.78,scale=iw*1.5:-1,format=gray,eq=contrast=1.6', f], { timeoutMs: 60_000 });
      const o = await run('tesseract', [f, 'stdout', '--psm', '6', '-l', 'eng'], { timeoutMs: 60_000 }); const words = (o.stdout.match(/[A-Za-z]{3,}/g) ?? []).length; if (words >= 4) hits++;
    } catch { /* ignore frame */ } finally { rmSync(f, { force: true }); }
  }
  return hits >= 2;
}
