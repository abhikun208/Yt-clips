import { statSync } from 'node:fs';
import { probe } from '../media/probe.ts';

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
