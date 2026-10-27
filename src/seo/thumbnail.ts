import { run } from '../util/proc.ts';
import { probe } from '../media/probe.ts';
import { existsSync, statSync, rmSync } from 'node:fs';

async function fontFor(text: string): Promise<string | null> {
  const q = /[\u0900-\u097F]/.test(text) ? ':lang=hi:bold' : 'Poppins:bold';
  const r = await run('fc-match', ['-f', '%{file}', q], { timeoutMs: 5000 }).catch(() => null);
  const f = r?.stdout.trim();
  return f && existsSync(f) ? f : null;
}
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '').replace(/%/g, '\\%');

/**
 * Real thumbnail from the clip itself: pick the sharpest-looking frame near `atSec`, add outlined text, write 1280x720 JPG.
 * Validates the output (dimensions + non-trivial content). Returns null on failure instead of faking one.
 */
export async function makeThumbnail(clipPath: string, out: string, text: string, atSec?: number): Promise<{ path: string; width: number; height: number } | null> {
  const info = await probe(clipPath);
  let t = Math.min(Math.max(0.5, atSec ?? info.duration * 0.35), info.duration - 0.2);
  if (atSec === undefined && info.duration > 3) { // sample a few frames and keep the most detailed one (JPEG size tracks sharpness/detail; flat/black frames lose)
    let best = -1;
    for (const f of [0.15, 0.3, 0.45, 0.6, 0.75]) {
      const ts = Math.min(Math.max(0.5, info.duration * f), info.duration - 0.2); const tmp = out + `.probe${Math.round(f * 100)}.jpg`;
      const r0 = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', ts.toFixed(2), '-i', clipPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', tmp], { timeoutMs: 20_000 }).catch(() => null);
      if (r0 && r0.code === 0 && existsSync(tmp)) { const sz = statSync(tmp).size; if (sz > best) { best = sz; t = ts; } }
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
  const font = await fontFor(text);
  const portrait = info.height > info.width;
  const dt = font ? `,drawtext=fontfile='${esc(font)}':text='${esc(text)}':fontcolor=yellow:fontsize=h*0.11:borderw=6:bordercolor=black:x=(w-text_w)/2:y=h*0.72` : '';
  const grade = 'eq=contrast=1.1:saturation=1.2';
  const vf = portrait // vertical clip: whole frame centred over a blurred copy instead of a thin centre crop
    ? `split[a][b];[a]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=24:4[bg];[b]scale=-2:720[fg];[bg][fg]overlay=(W-w)/2:0,${grade}${dt}`
    : `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,${grade}${dt}`;
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', clipPath, '-frames:v', '1', portrait ? '-filter_complex' : '-vf', vf, '-q:v', '2', out], { timeoutMs: 60_000 });
  if (r.code !== 0 || !existsSync(out)) return null;
  const p = await probe(out);
  // Reject blank/flat thumbnails: measure luma range via signalstats YMIN/YMAX.
  const s = await run('ffmpeg', ['-hide_banner', '-i', out, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { timeoutMs: 30_000 });
  const ymin = Number(s.stdout.match(/YMIN=(\d+)/)?.[1] ?? 0); const ymax = Number(s.stdout.match(/YMAX=(\d+)/)?.[1] ?? 0);
  if (p.width !== 1280 || p.height !== 720 || ymax - ymin < 40) return null;
  return { path: out, width: p.width, height: p.height };
}
