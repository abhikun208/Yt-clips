import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run } from '../util/proc.ts';
import { downloadVideo } from '../sources/youtube.ts';
import { info, warn } from '../util/log.ts';

export const DECODE_ERR = /AV1\/corrupt|dav1d|obu_|Failed to parse temporal|Invalid data found|moov atom/i;
const dur = async (f: string) => { const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { timeoutMs: 30_000 }).catch(() => null); const n = Number(r?.stdout.trim()); return Number.isFinite(n) ? n : 0; };

/**
 * A stored source video that ffmpeg cannot decode (AV1/corrupt download): fetch the SAME YouTube video again as H.264, check it decodes and
 * has the same length, then point the existing video row at the new file (id, candidates, transcript sidecar stay). The old file is kept.
 */
export async function repairVideo(store: Store, cfg: Config, videoId: number, o: { download?: typeof downloadVideo } = {}): Promise<{ ok: boolean; note: string }> {
  const v = store.get<{ id: number; path: string; duration: number | null; source_id: number | null }>('SELECT id, path, duration, source_id FROM videos WHERE id=?', videoId); if (!v) return { ok: false, note: 'unknown video' };
  const s = v.source_id ? store.get<{ kind: string; uri: string }>('SELECT kind, uri FROM sources WHERE id=?', v.source_id) : null;
  if (!s || s.kind !== 'youtube_video') return { ok: false, note: 'not a YouTube download — re-upload the file (nothing to re-fetch)' };
  const tmp = join(cfg.dirs.tmp, 'repair'); mkdirSync(tmp, { recursive: true }); let nf: string | undefined;
  try {
    nf = await (o.download ?? downloadVideo)(s.uri, tmp, cfg.youtube.maxHeight, { strictH264: true, name: `repair_${v.id}.%(ext)s` });
    const t = await run('ffmpeg', ['-v', 'error', '-i', nf, '-t', '20', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 }); if (t.code !== 0 || /error|invalid/i.test(t.stderr)) return { ok: false, note: `re-download still does not decode: ${t.stderr.slice(0, 100)}` };
    const d = await dur(nf); if (v.duration && Math.abs(d - v.duration) > 3) return { ok: false, note: `re-download length ${d.toFixed(0)}s ≠ ${v.duration.toFixed(0)}s` };
    const dest = join(dirname(v.path), `${v.path.split('/').pop()!.replace(/\.[^.]+$/, '')}.h264.mp4`); copyFileSync(nf, dest);
    for (const ext of ['.json', '.live_chat.json', '.chat.json', '.heatmap.json']) { const sc = v.path.replace(/\.[^.]+$/, '') + ext; if (existsSync(sc)) copyFileSync(sc, dest.replace(/\.[^.]+$/, '') + ext); }
    store.exec('UPDATE videos SET path=? WHERE id=?', dest, v.id);
    store.exec(`UPDATE jobs SET state='PENDING', attempts=0, run_after=0, last_error=NULL, updated_at=datetime('now') WHERE kind='render' AND state IN ('DEAD','RETRY') AND CAST(substr(key, 8) AS INTEGER) IN (SELECT id FROM candidates WHERE video_id=?)`, v.id);
    info('source repaired (H.264 re-download)', { videoId }); return { ok: true, note: 'source re-downloaded as H.264; render jobs re-queued' };
  } catch (e) { warn('source repair failed', { videoId, err: (e as Error).message.slice(0, 120) }); return { ok: false, note: (e as Error).message.slice(0, 120) }; }
  finally { if (nf) rmSync(nf, { force: true }); }
}
