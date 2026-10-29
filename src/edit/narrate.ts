import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/proc.ts';
import { synthesize, type TtsOpts } from '../tts/engine.ts';

/** ffmpeg filter graph: original audio ducked while the narration plays, narration mixed on top (starts after `delay` s). */
export function narrationGraph(durNarr: number, delay: number, duck: number): string {
  const end = (delay + durNarr + 0.2).toFixed(2);
  return `[0:a]volume=${duck}:enable='between(t,${delay},${end})'[o];[1:a]adelay=${Math.round(delay * 1000)}|${Math.round(delay * 1000)},volume=1.15[n];[o][n]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`;
}

/**
 * Optional voice-over of the clip's hook sentence over the first seconds (free TTS: edge-tts or piper, both optional).
 * Returns false (clip untouched) when no TTS provider exists, the clip has no audio, or anything fails — never breaks a render.
 */
export async function narrate(clipPath: string, text: string, dir: string, o: TtsOpts & { duck?: number; delay?: number } = {}): Promise<boolean> {
  try {
    const t = await synthesize(text, dir, o); if (!t) return false;
    const pr = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', t.path], { timeoutMs: 20_000 }); const dn = Number(pr.stdout.trim());
    const pc = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', clipPath], { timeoutMs: 20_000 });
    if (!Number.isFinite(dn) || dn <= 0 || dn > 12 || !pc.stdout.includes('audio')) return false;
    const out = join(dir, `narr_${Date.now()}.mp4`);
    const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', clipPath, '-i', t.path, '-filter_complex', narrationGraph(dn, o.delay ?? 0.3, o.duck ?? 0.25), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { timeoutMs: 5 * 60_000 });
    if (r.code !== 0 || !existsSync(out)) { rmSync(out, { force: true }); return false; }
    renameSync(out, clipPath); return true;
  } catch { return false; }
}
