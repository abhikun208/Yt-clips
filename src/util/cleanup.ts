import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { freeMb } from './disk.ts';

/**
 * Low-disk self-healing. Order of what may be deleted (never source videos, never raw clips, never clips the owner has not
 * decided on): 1) stale temp files, 2) rendered files of REJECTED clips, 3) oldest clips that are already published
 * (the platform keeps the video; the row stays). Stops as soon as enough space is free.
 */
export function freeUpSpace(store: Store, cfg: Config, needMb: number): { freedMb: number; actions: string[] } {
  const actions: string[] = []; let freed = 0; const enough = () => freeMb(cfg.dataDir) >= needMb;
  const rm = (f: string | null | undefined, why: string) => { if (!f || !existsSync(f)) return; try { const sz = statSync(f).size; rmSync(f, { force: true }); freed += sz / 1048576; actions.push(`${why}: ${f.split('/').slice(-1)[0]}`); } catch { /* skip */ } };
  try { for (const n of readdirSync(cfg.dirs.tmp)) { if (enough()) break; const f = join(cfg.dirs.tmp, n); try { if (Date.now() - statSync(f).mtimeMs > 3600_000) { rmSync(f, { recursive: true, force: true }); actions.push(`tmp: ${n}`); } } catch { /* skip */ } } } catch { /* no tmp dir */ }
  if (!enough()) for (const c of store.all<{ edited_path: string | null; thumbnail_path: string | null }>(`SELECT edited_path, thumbnail_path FROM clips WHERE review='rejected' AND edited_path IS NOT NULL ORDER BY id`)) { if (enough()) break; rm(c.edited_path, 'rejected clip'); rm(c.thumbnail_path, 'rejected thumb'); }
  if (!enough()) for (const c of store.all<{ edited_path: string | null }>(`SELECT c.edited_path FROM clips c WHERE c.edited_path IS NOT NULL AND EXISTS (SELECT 1 FROM uploads u WHERE u.clip_id=c.id AND u.remote_id IS NOT NULL) ORDER BY c.id LIMIT 200`)) { if (enough()) break; rm(c.edited_path, 'published clip (oldest first)'); }
  return { freedMb: Math.round(freed), actions };
}
