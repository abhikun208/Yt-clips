import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

export interface Probe { path: string; name: string; duration: number; width: number; height: number; fps: number; hasAudio: boolean; isImage: boolean }
export const haveFfmpeg = (): boolean => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
/** ffprobe: duration in MICROseconds (what drafts use). */
export function probe(path: string): Probe {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) throw new Error(`ffprobe could not read ${path}${r.error ? ' (is ffmpeg installed?)' : ''}: ${(r.stderr ?? '').trim().slice(0, 120)}`);
  const j = JSON.parse(r.stdout) as { streams?: { codec_type: string; width?: number; height?: number; r_frame_rate?: string; duration?: string; codec_name?: string }[]; format?: { duration?: string; format_name?: string } };
  const v = j.streams?.find((s) => s.codec_type === 'video'); const a = j.streams?.find((s) => s.codec_type === 'audio');
  const isImage = !!v && /image2|png_pipe|jpeg_pipe|webp_pipe|gif/.test(j.format?.format_name ?? '') && !a;
  const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0); const [n, d] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
  return { path, name: basename(path), duration: Math.round(dur * 1e6), width: v?.width ?? 0, height: v?.height ?? 0, fps: d ? Math.round(((n ?? 0) / d) * 100) / 100 : 0, hasAudio: !!a, isImage };
}
/** Speech pieces of a media file (start/end in µs) from ffmpeg silencedetect. */
export function speechPieces(path: string, durationUs: number, o: { noiseDb?: number; minSilence?: number } = {}): { start: number; end: number }[] {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', `silencedetect=n=${o.noiseDb ?? -35}dB:d=${o.minSilence ?? 0.5}`, '-f', 'null', '-'], { encoding: 'utf8', timeout: 4 * 3600_000, maxBuffer: 64 * 1024 * 1024 });
  const sil: { start: number; end: number }[] = []; let cur: number | null = null;
  for (const l of (r.stderr ?? '').split('\n')) { const a = /silence_start: (-?[\d.]+)/.exec(l); if (a) cur = Math.max(0, Number(a[1])) * 1e6; const b = /silence_end: (-?[\d.]+)/.exec(l); if (b && cur !== null) { sil.push({ start: cur, end: Number(b[1]) * 1e6 }); cur = null; } }
  if (cur !== null) sil.push({ start: cur, end: durationUs });
  const out: { start: number; end: number }[] = []; let at = 0; for (const s of sil) { if (s.start - at > 200_000) out.push({ start: at, end: s.start }); at = s.end; } if (durationUs - at > 200_000) out.push({ start: at, end: durationUs }); return out;
}
