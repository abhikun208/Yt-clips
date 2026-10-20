import { run } from '../util/proc.ts';
import { probe } from '../media/probe.ts';

export interface QcResult { pass: boolean; checks: Record<string, { ok: boolean; value?: number | string; note?: string }>; failures: string[] }

export interface QcExpect { width: number; height: number; duration: number; durTol?: number; targetLufs?: number; lufsTol?: number; requireAudio: boolean; maxBlackRatio?: number }

export function parseEbur128(stderr: string): { lufs: number | null; truePeak: number | null } {
  const sec = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = sec.match(/I:\s*(-?[\d.]+)\s*LUFS/); const tp = sec.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);
  return { lufs: i ? Number(i[1]) : null, truePeak: tp ? Number(tp[1]) : null };
}

/** Real media QC via ffprobe + ffmpeg analysis. Never returns pass without measuring. */
export async function qcClip(path: string, x: QcExpect): Promise<QcResult> {
  const checks: QcResult['checks'] = {};
  const fail: string[] = [];
  const set = (k: string, ok: boolean, value?: number | string, note?: string) => { checks[k] = { ok, value, note }; if (!ok) fail.push(`${k}${note ? `: ${note}` : ''}`); };
  let m;
  try { m = await probe(path); } catch (e) { return { pass: false, checks: { probe: { ok: false, note: (e as Error).message } }, failures: ['probe'] }; }
  set('resolution', m.width === x.width && m.height === x.height, `${m.width}x${m.height}`, `expected ${x.width}x${x.height}`);
  set('duration', Math.abs(m.duration - x.duration) <= (x.durTol ?? 0.6), m.duration.toFixed(2), `expected ~${x.duration.toFixed(2)}`);
  set('codec', m.videoCodec === 'h264', m.videoCodec);
  set('audio_present', x.requireAudio ? m.hasAudio : true, m.hasAudio ? 'yes' : 'no');
  if (m.hasAudio && x.targetLufs !== undefined) {
    const r = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', path, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 });
    const l = parseEbur128(r.stderr);
    set('loudness', l.lufs !== null && Math.abs(l.lufs - x.targetLufs) <= (x.lufsTol ?? 2.5), l.lufs ?? 'n/a', `target ${x.targetLufs}±${x.lufsTol ?? 2.5}`);
    set('true_peak', l.truePeak === null || l.truePeak <= -0.5, l.truePeak ?? 'n/a', 'clipping risk');
  }
  const bd = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', path, '-an', '-vf', 'fps=4,scale=160:-2,blackdetect=d=0.4:pix_th=0.1', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 });
  let black = 0; for (const mm of bd.stderr.matchAll(/black_duration:([\d.]+)/g)) black += Number(mm[1]);
  set('black_frames', black / m.duration <= (x.maxBlackRatio ?? 0.25), +(black / m.duration).toFixed(3), 'too much black');
  const dec = await run('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { timeoutMs: 5 * 60_000 });
  set('decodes_clean', dec.code === 0 && dec.stderr.trim() === '', dec.stderr.trim().slice(0, 120) || 'ok');
  return { pass: fail.length === 0, checks, failures: fail };
}
