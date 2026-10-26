import { run } from '../util/proc.ts';

export interface MediaInfo { duration: number; width: number; height: number; fps: number; hasAudio: boolean; videoCodec: string; audioCodec?: string; sampleRate?: number; rotation: number; interlaced?: boolean }

function parseFps(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  return b && a ? a / b : Number(a) || 0;
}

export async function probe(path: string): Promise<MediaInfo> {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`ffprobe failed for ${path}: ${r.stderr.trim().slice(0, 300)}`);
  const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<Record<string, any>> };
  const v = j.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`No video stream in ${path}`);
  const duration = Number(j.format?.duration ?? v.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid duration for ${path}`);
  const rot = Number(v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  const rotation = ((rot % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  return {
    duration, width: swap ? v.height : v.width, height: swap ? v.width : v.height,
    fps: parseFps(v.avg_frame_rate) || parseFps(v.r_frame_rate), hasAudio: !!a, videoCodec: v.codec_name,
    audioCodec: a?.codec_name, sampleRate: a ? Number(a.sample_rate) : undefined, rotation, interlaced: ['tt', 'bb', 'tb', 'bt'].includes(String(v.field_order ?? '')),
  };
}
