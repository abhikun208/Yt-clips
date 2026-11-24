import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { run } from '../util/proc.ts';

/**
 * Live chunks are only PROCESSING units: a moment can straddle two of them. For every finished chunk we keep its last `tailSec` and first `headSec`
 * (stream copy: instant, nothing re-encoded) and build a short BRIDGE video from [previous tail + this head]. The analyzer then only keeps moments that
 * cover the seam, so nothing is lost at a chunk edge and nothing is analysed twice in full.
 */
export interface Ends { tail: string; head: string; tailSec: number; headSec: number }
export async function extractEnds(file: string, dir: string, tag: string, tailSec = 20, headSec = 20): Promise<Ends | null> {
  const tail = join(dir, `bridge_${tag}_tail.ts`), head = join(dir, `bridge_${tag}_head.ts`);
  const a = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-sseof', `-${tailSec}`, '-i', file, '-c', 'copy', '-f', 'mpegts', tail], { timeoutMs: 60_000 });
  const b = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-t', String(headSec), '-c', 'copy', '-f', 'mpegts', head], { timeoutMs: 60_000 });
  if (a.code !== 0 || b.code !== 0 || !existsSync(tail) || !existsSync(head) || statSync(tail).size < 1000 || statSync(head).size < 1000) return null;
  return { tail, head, tailSec, headSec };
}
/** previous chunk's tail + next chunk's head as one small mp4; returns the seam position (seconds into the bridge) */
export async function makeBridge(prev: Ends, next: Ends, out: string): Promise<{ seam: number } | null> {
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', `concat:${prev.tail}|${next.head}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0 || !existsSync(out)) return null;
  const d = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(out)], { timeoutMs: 20_000 });
  const total = Number(d.stdout.trim()); const headLen = next.headSec;
  return { seam: Number.isFinite(total) && total > headLen ? +(total - headLen).toFixed(2) : prev.tailSec };
}
