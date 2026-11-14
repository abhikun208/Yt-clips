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

/** Edge density (0..255 mean of an edge map) of a horizontal band [y0,y1] of the frame at time t, or null when ffmpeg fails. */
async function bandEdges(path: string, t: number, y0: number, y1: number): Promise<number | null> {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', t.toFixed(2), '-i', path, '-frames:v', '1', '-an', '-vf', `crop=iw:ih*${(y1 - y0).toFixed(2)}:0:ih*${y0.toFixed(2)},scale=360:-2,format=gray,edgedetect=low=0.12:high=0.3,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-'], { timeoutMs: 60_000 }).catch(() => null);
  const m = r ? /YAVG=([\d.]+)/.exec(r.stdout + r.stderr) : null; return m ? Number(m[1]) : null;
}
/**
 * Tesseract-free guess: does the source carry its own subtitles / lower-third text in the bottom band (y 72-90%)? Text is dense in edges compared to a quiet reference band
 * in the middle; checked on 4 frames, needs 2 hits. Used only to LIFT our captions (never to change the layout), so a false positive costs a slightly higher caption.
 * Thresholds are tuned on synthetic frames only - UNVERIFIED on real footage.
 */
export async function bottomBandBusy(path: string, start: number, end: number): Promise<{ busy: boolean; hits: number; samples: number }> {
  let hits = 0, samples = 0; const n = 4;
  for (let i = 0; i < n; i++) {
    const t = start + ((end - start) * (i + 0.5)) / n; const b = await bandEdges(path, t, 0.72, 0.9); const ref = await bandEdges(path, t, 0.3, 0.48);
    if (b === null || ref === null) continue; samples++; if (b > 6 && b > ref * 1.6) hits++;
  }
  return { busy: hits >= 2, hits, samples };
}
