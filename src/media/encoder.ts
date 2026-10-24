import { run } from '../util/proc.ts';
import type { Config } from '../config.ts';

/**
 * Video encoder selection. 'auto' PROBES (a real 8-frame encode) each hardware encoder once per process and uses the first that
 * works, else libx264. Supported hardware encoders take ordinary software frames, so the existing filter graphs are unchanged:
 * NVIDIA NVENC, Apple VideoToolbox, Android MediaCodec (only if the ffmpeg build has it). VAAPI/QSV need hwupload filters and are NOT
 * supported. Any hardware failure at render time falls back to libx264 (see withEncoderFallback). The probe is truthful: "available"
 * means "ffmpeg here just encoded frames with it", never "the name is listed".
 */
export const ENCODERS = ['auto', 'libx264', 'h264_nvenc', 'h264_videotoolbox', 'h264_mediacodec'] as const;
export type EncoderName = (typeof ENCODERS)[number];
const HW = ['h264_nvenc', 'h264_videotoolbox', 'h264_mediacodec'] as const;
const cache = new Map<string, boolean>(); let autoPick: string | null = null;

export async function probeEncoder(name: string): Promise<boolean> {
  if (name === 'libx264') return true;
  const hit = cache.get(name); if (hit !== undefined) return hit;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=30:d=0.3', '-frames:v', '8', '-c:v', name, '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { timeoutMs: 20_000 }).catch(() => ({ code: 1 }));
  const ok = r.code === 0; cache.set(name, ok); return ok;
}
export async function detectEncoders(): Promise<{ name: string; available: boolean }[]> { return Promise.all(HW.map(async (name) => ({ name, available: await probeEncoder(name) }))); }
/** Encoder that will actually be used for the configured setting. */
export async function resolveEncoder(cfg: Config): Promise<string> {
  const want = cfg.edit.encoder ?? 'auto';
  if (want === 'libx264') return 'libx264';
  if (want !== 'auto') return (await probeEncoder(want)) ? want : 'libx264';
  if (autoPick) return autoPick;
  for (const n of HW) if (await probeEncoder(n)) return (autoPick = n);
  return (autoPick = 'libx264');
}
/** ffmpeg output-video args for an encoder. crf maps to the nearest quality knob of each encoder (approximate, not equal quality). */
export function encodeArgs(enc: string, o: { crf: number; preset: string }): string[] {
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', enc, '-preset', 'p4', '-rc', 'vbr', '-cq', String(Math.min(51, o.crf + 3)), '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'h264_videotoolbox': return ['-c:v', enc, '-q:v', String(Math.max(30, Math.min(80, 80 - (o.crf - 16) * 3))), '-pix_fmt', 'yuv420p'];
    case 'h264_mediacodec': return ['-c:v', enc, '-b:v', '8M', '-pix_fmt', 'yuv420p'];
    default: return ['-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p'];
  }
}
/** Run an encode with the resolved encoder; if a HARDWARE encode fails, retry once with libx264 so a flaky GPU never blocks the pipeline. */
export async function withEncoderFallback<T extends { code: number }>(cfg: Config, build: (enc: string) => Promise<T>): Promise<T & { encoder: string }> {
  const enc = await resolveEncoder(cfg); let r = await build(enc);
  if (r.code !== 0 && enc !== 'libx264') { cache.set(enc, false); autoPick = null; r = await build('libx264'); return { ...r, encoder: 'libx264' }; }
  return { ...r, encoder: enc };
}
