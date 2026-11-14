import { existsSync, statSync, rmSync, renameSync } from 'node:fs';
import { dirname, basename, extname, join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { downloadVideo } from './youtube.ts';
import { probe } from '../media/probe.ts';
import { info } from '../util/log.ts';

/**
 * Bring back a source that cleanup deleted: re-download the SAME YouTube video with yt-dlp to the same path. The new file must have (nearly) the same duration
 * as the original (clip times depend on it), otherwise it is rejected and nothing changes. Used by the "Re-fetch Source" button and automatically before a re-render/re-analyze.
 */
export async function refetchSource(store: Store, cfg: Config, videoId: number): Promise<{ path: string; mb: number }> {
  const v = store.get<{ id: number; path: string; duration: number; uri: string; kind: string }>('SELECT v.id, v.path, v.duration, s.uri, s.kind FROM videos v JOIN sources s ON s.id=v.source_id WHERE v.id=?', videoId);
  if (!v) throw new Error('unknown video'); if (v.kind !== 'youtube_video') throw new Error('Ye video tumne upload ki thi, YouTube se dobara nahi aa sakti (isi liye hum ise delete nahi karte)');
  if (existsSync(v.path)) return { path: v.path, mb: statSync(v.path).size / 1048576 };
  const dir = dirname(v.path); const stem = basename(v.path, extname(v.path));
  const got = await downloadVideo(v.uri, dir, cfg.youtube.maxHeight ?? 720, { name: `${stem}.refetch.%(ext)s` });
  try { const d = (await probe(got)).duration; if (Math.abs(d - v.duration) > 3) throw new Error(`dobara download ki hui video ki length alag hai (${d.toFixed(1)}s vs ${v.duration.toFixed(1)}s) - clips ke times mismatch honge`); }
  catch (e) { rmSync(got, { force: true }); throw e; }
  renameSync(got, v.path); store.exec('DELETE FROM kv WHERE k=?', `local:pruned:${videoId}`); info('source re-fetched', { video: videoId }); return { path: v.path, mb: statSync(v.path).size / 1048576 };
}
