import { statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { probe } from '../media/probe.ts';
import { run } from '../util/proc.ts';

/** Per-platform output limits. Conservative defaults taken from the platforms' published Shorts/Reels/TikTok guidance — re-check against current provider docs; override via data/config.json (automation.mediaLimits). */
export interface MediaLimit { maxSeconds: number; maxMB: number; vertical: boolean }
export const DEFAULT_LIMITS: Record<string, MediaLimit> = {
  youtube_shorts: { maxSeconds: 180, maxMB: 2048, vertical: true },
  facebook_reels: { maxSeconds: 90, maxMB: 1024, vertical: true },
  instagram_reels: { maxSeconds: 90, maxMB: 1024, vertical: true },
  tiktok: { maxSeconds: 600, maxMB: 287, vertical: true },
};

/** FFprobe the exact file that is about to be uploaded. Returns problems (empty = ok). A missing ffprobe binary is reported as unverifiable, not as a pass. */
export async function checkMedia(path: string, platform: string, limits: Record<string, MediaLimit> = DEFAULT_LIMITS): Promise<{ ok: boolean; problems: string[]; info?: { seconds: number; width: number; height: number; mb: number; codec: string } }> {
  const lim = limits[platform]; if (!lim) return { ok: true, problems: [] };
  let st; try { st = statSync(path); } catch { return { ok: false, problems: [`file nahi mili: ${path}`] }; }
  let info; try { info = await probe(path); } catch (e) { return { ok: false, problems: [`ffprobe: ${String((e as Error).message).slice(0, 160)}`] }; }
  const problems: string[] = []; const mb = st.size / 1048576;
  if (info.duration > lim.maxSeconds) problems.push(`duration ${info.duration.toFixed(1)}s > ${lim.maxSeconds}s limit (${platform})`);
  if (mb > lim.maxMB) problems.push(`size ${mb.toFixed(0)}MB > ${lim.maxMB}MB`);
  if (lim.vertical && info.width > info.height) problems.push(`${info.width}x${info.height} horizontal hai — ${platform} ke liye vertical/square chahiye`);
  if (!['h264', 'hevc', 'vp9', 'av1'].includes(info.videoCodec)) problems.push(`codec ${info.videoCodec} supported nahi`);
  return { ok: problems.length === 0, problems, info: { seconds: info.duration, width: info.width, height: info.height, mb, codec: info.videoCodec } };
}

/**
 * Platform-specific derived output. The master clip is NEVER modified; when its FFprobe facts break a destination's limit in a way that can be fixed
 * mechanically, a derived copy `<clip>.<platform>.mp4` is encoded and re-validated, and THAT file is uploaded:
 *   too big (MB)      -> H.264/AAC re-encode at the bitrate that fits ~90% of the limit
 *   duration > limit  -> trimmed to the limit (clip stays a valid Short/Reel; the note says so)
 *   unsupported codec -> H.264/AAC yuv420p
 * Not fixable (e.g. horizontal video for a vertical-only platform) stays a MEDIA_INVALID block.
 */
export async function prepareForPlatform(path: string, platform: string, limits: Record<string, MediaLimit> = DEFAULT_LIMITS): Promise<{ ok: boolean; path: string; derived: boolean; notes: string[]; problems: string[] }> {
  const first = await checkMedia(path, platform, limits);
  if (first.ok) return { ok: true, path, derived: false, notes: [], problems: [] };
  const lim = limits[platform]!; const info = first.info; const horizontal = first.problems.some((p) => /horizontal/.test(p));
  if (!info || horizontal || first.problems.some((p) => /file nahi mili|ffprobe/.test(p))) return { ok: false, path, derived: false, notes: [], problems: first.problems };
  const out = path.replace(/\.[^.]+$/, '') + `.${platform}.mp4`; const notes: string[] = [];
  const secs = Math.min(info.seconds, lim.maxSeconds - 0.3); if (info.seconds > lim.maxSeconds) notes.push(`trimmed ${info.seconds.toFixed(1)}s -> ${secs.toFixed(1)}s (${platform} limit ${lim.maxSeconds}s)`);
  const targetKbps = Math.max(300, Math.floor((lim.maxMB * 0.9 * 8192) / Math.max(1, secs)) - 128); const needRate = info.mb > lim.maxMB; if (needRate) notes.push(`re-encoded ${info.mb.toFixed(0)}MB -> <=${lim.maxMB}MB`);
  if (!['h264'].includes(info.codec)) notes.push(`codec ${info.codec} -> h264`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-t', secs.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...(needRate ? ['-b:v', `${Math.min(targetKbps, 20000)}k`, '-maxrate', `${Math.min(targetKbps, 20000)}k`, '-bufsize', `${Math.min(targetKbps, 20000) * 2}k`] : ['-crf', '20']), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
  if (!existsSync(out)) { const r = await run('ffmpeg', args, { timeoutMs: 20 * 60_000 }); if (r.code !== 0) return { ok: false, path, derived: false, notes, problems: [...first.problems, `re-encode fail: ${r.stderr.trim().slice(-160)}`] }; }
  const again = await checkMedia(out, platform, limits); // the derived file is FFprobe-validated too
  return again.ok ? { ok: true, path: out, derived: true, notes, problems: [] } : { ok: false, path, derived: false, notes, problems: again.problems.map((x) => `derived: ${x}`) };
}
