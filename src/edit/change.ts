import { run } from '../util/proc.ts';
import { reframeParts, type VideoGraphOpts } from './filters.ts';

export interface VisualChange { ssim: number; change: number; method: string }

/**
 * Measured visual change: SSIM between the plain 9:16 reframe of the same source (no grade/zoom/vfx/captions) and the final edit,
 * both downscaled to 135x240 @5fps. change = 1 - SSIM (0 = identical, higher = more different). Time-aligned (the ramped source is the baseline).
 * This is a structural-difference measurement, not a copyright-evasion metric.
 */
export async function measureVisualChange(baseSrc: string, finalPath: string, g: Pick<VideoGraphOpts, 'inW' | 'inH' | 'outW' | 'outH' | 'reframe' | 'cropXFrac'>): Promise<VisualChange | null> {
  const rf = reframeParts(g, '0:v');
  const graph = `${rf.parts.join(';')};[base]scale=135:240:flags=area,fps=5[a];[1:v]scale=135:240:flags=area,fps=5[b];[a][b]ssim`;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-i', baseSrc, '-i', finalPath, '-filter_complex', graph, '-f', 'null', '-'], { timeoutMs: 5 * 60_000 });
  const m = /All:([0-9.]+)/.exec(r.stderr);
  if (r.code !== 0 || !m) return null;
  const ssim = Math.min(1, Math.max(0, Number(m[1])));
  return { ssim: +ssim.toFixed(4), change: +(1 - ssim).toFixed(4), method: '1-SSIM vs plain reframe, 135x240@5fps' };
}
