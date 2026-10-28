import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/proc.ts';
import { probe } from '../media/probe.ts';

/** Owner's own short "hook"/meme intro clips live in assets/hooks/. One is picked deterministically per candidate. Nothing is bundled. */
export function pickHook(assetsDir: string, seed: number): string | null {
  const d = join(assetsDir, 'hooks'); if (!existsSync(d)) return null;
  const fs = readdirSync(d).filter((x) => /\.(mp4|mov|mkv|webm)$/i.test(x)).sort(); return fs.length ? join(d, fs[seed % fs.length]!) : null;
}

/** Prepend `hook` (first ≤ maxSec seconds) to the finished clip. Both are normalised to the clip's size/fps/audio so concat is exact. In-place replace; returns the hook length added. */
export async function prependHook(clipPath: string, hook: string, o: { width: number; height: number; fps: number; maxSec?: number }): Promise<number> {
  const hp = await probe(hook); const cp = await probe(clipPath); const len = Math.min(hp.duration, o.maxSec ?? 3);
  const norm = (i: number, lab: string, d: number, aud: boolean) => `[${i}:v]trim=0:${d.toFixed(2)},setpts=PTS-STARTPTS,scale=${o.width}:${o.height}:force_original_aspect_ratio=increase,crop=${o.width}:${o.height},setsar=1,fps=${o.fps},format=yuv420p[v${lab}];`
    + (aud ? `[${i}:a]atrim=0:${d.toFixed(2)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${lab}];` : `anullsrc=r=48000:cl=stereo,atrim=0:${d.toFixed(2)}[a${lab}];`);
  const g = norm(0, 'h', len, hp.hasAudio) + norm(1, 'c', cp.duration, cp.hasAudio) + '[vh][ah][vc][ac]concat=n=2:v=1:a=1[v][a]';
  const out = clipPath + '.hook.mp4';
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', hook, '-i', clipPath, '-filter_complex', g, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { timeoutMs: 20 * 60_000 });
  if (r.code !== 0) { rmSync(out, { force: true }); throw new Error(`hook prepend failed: ${r.stderr.slice(0, 200)}`); }
  renameSync(out, clipPath); return len;
}
