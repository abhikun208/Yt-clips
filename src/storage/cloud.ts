import { existsSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run, which } from '../util/proc.ts';
import { info, warn } from '../util/log.ts';

/**
 * Cloud storage through rclone (the user's own remote: Google Drive, OneDrive, Backblaze, MEGA, S3, a 1 TB plan ...). rclone does the login in the browser, so this
 * project never sees a password. NOTE: editing still needs the original on local disk while clips are rendered; cloud is where finished sources are moved
 * (and restored from on demand) so the device does not fill up. Nothing is deleted locally unless it was copied AND size-verified in the cloud first.
 */
export const SIDECARS = ['.json', '.live_chat.json', '.heatmap.json'];
const DONE = new Set(['PUBLISHED', 'ANALYTICS_WAIT', 'ANALYZING', 'LEARNING', 'NEXT_CYCLE']);
const remoteOf = (cfg: Config) => (cfg.storage.remote || '').trim().replace(/\/+$/, '');
export const rcloneAvailable = () => which('rclone');
export const validRemote = (r: string) => /^[\w.-]+:[\w ./-]*$/.test(r) && !r.includes('..');

export async function listRemotes(): Promise<string[]> { const r = await run('rclone', ['listremotes'], { timeoutMs: 20_000 }).catch(() => null); return r && r.code === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : []; }
async function lsjson(path: string): Promise<{ Name: string; Size: number }[] | null> { const r = await run('rclone', ['lsjson', path], { timeoutMs: 120_000 }).catch(() => null); if (!r || r.code !== 0) return null; try { return JSON.parse(r.stdout || '[]'); } catch { return null; } }
async function pushFile(local: string, dir: string): Promise<boolean> {
  const r = await run('rclone', ['copyto', local, `${dir}/${basename(local)}`, '--retries', '3'], { timeoutMs: 6 * 60 * 60_000 }); if (r.code !== 0) return false;
  const l = await lsjson(`${dir}/${basename(local)}`); return !!l && l.length === 1 && l[0]!.Size === statSync(local).size; // verified by size, not by exit code alone
}
export async function testRemote(cfg: Config): Promise<{ ok: boolean; detail: string }> {
  const rem = remoteOf(cfg); if (!rem) return { ok: false, detail: 'remote set nahi (jaise gdrive:yt-clips)' };
  if (!(await rcloneAvailable())) return { ok: false, detail: 'rclone install nahi: Termux `pkg install rclone`, Linux `apt install rclone`' };
  if (!validRemote(rem)) return { ok: false, detail: 'remote ka format galat (name:folder)' };
  const dir = join(cfg.dirs.tmp, 'cloudtest'); mkdirSync(dir, { recursive: true }); const f = join(dir, `ytc_test_${Date.now()}.txt`); writeFileSync(f, 'yt-clips storage test');
  try { const ok = await pushFile(f, `${rem}/_test`); if (!ok) return { ok: false, detail: `${rem} par likh nahi paya: rclone config/login check karo (remote name sahi? internet?)` }; await run('rclone', ['purge', `${rem}/_test`], { timeoutMs: 60_000 }); return { ok: true, detail: `${rem} par likh/padh/delete ho gaya` }; }
  finally { rmSync(f, { force: true }); }
}

interface Entry { remote: string; files: string[]; at: string; doneAt?: string; purged?: boolean; localDeleted?: boolean }
const key = (id: number) => `cloud:video:${id}`;
const getEntry = (s: Store, id: number): Entry | null => { try { return JSON.parse(s.get<{ v: string }>('SELECT v FROM kv WHERE k=?', key(id))?.v ?? 'null'); } catch { return null; } };
const setEntry = (s: Store, id: number, e: Entry) => s.exec('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', key(id), JSON.stringify(e));
const filesOf = (path: string) => { const base = path.replace(/\.[^.]+$/, ''); return [path, ...SIDECARS.map((e) => base + e)].filter((f) => existsSync(f)); };

/** Videos whose every upload reached PUBLISHED or later (and that have at least one upload). */
export function finishedVideos(store: Store): { id: number; path: string }[] {
  return store.all<{ id: number; path: string; n: number; done: number }>(`SELECT v.id, v.path, COUNT(u.id) n, SUM(CASE WHEN u.state IN ('PUBLISHED','ANALYTICS_WAIT','ANALYZING','LEARNING','NEXT_CYCLE') THEN 1 ELSE 0 END) done
    FROM videos v JOIN candidates c ON c.video_id=v.id JOIN clips k ON k.candidate_id=c.id JOIN uploads u ON u.clip_id=k.id WHERE u.state NOT IN ('FAILED','QC_FAILED') GROUP BY v.id HAVING n>0 AND n=done`).map((r) => ({ id: r.id, path: r.path }));
}
export async function archiveVideo(store: Store, cfg: Config, id: number, path: string): Promise<{ ok: boolean; detail: string }> {
  const rem = remoteOf(cfg); const files = filesOf(path); if (!files.length) return { ok: false, detail: 'local file already gone' };
  const dir = `${rem}/raw/${id}`; for (const f of files) if (!(await pushFile(f, dir))) return { ok: false, detail: `${basename(f)} upload verify fail` };
  const e: Entry = { remote: dir, files: files.map((f) => basename(f)), at: new Date().toISOString(), doneAt: new Date().toISOString() };
  if (cfg.storage.deleteLocal) { for (const f of files) rmSync(f, { force: true }); e.localDeleted = true; }
  setEntry(store, id, e); info('cloud archive', { video: id, files: files.length, localDeleted: !!e.localDeleted }); return { ok: true, detail: `${files.length} file(s) → ${dir}${e.localDeleted ? ' (local delete)' : ''}` };
}
/** Bring an archived original back (re-render / re-analysis). No-op if present locally; throws if it cannot be restored. */
export async function ensureLocal(store: Store, cfg: Config, path: string): Promise<void> {
  if (existsSync(path)) return; const v = store.get<{ id: number }>('SELECT id FROM videos WHERE path=?', path); const e = v ? getEntry(store, v.id) : null;
  if (!e || e.purged) throw new Error(`original missing locally and ${e?.purged ? 'cloud copy was purged' : 'not archived in cloud'}: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  for (const name of e.files) { const r = await run('rclone', ['copyto', `${e.remote}/${name}`, join(dirname(path), name), '--retries', '3'], { timeoutMs: 6 * 60 * 60_000 }); if (r.code !== 0 && name === basename(path)) throw new Error('cloud restore failed'); }
  if (!existsSync(path)) throw new Error('cloud restore failed'); info('cloud restore', { video: v!.id });
}
/** Worker step: archive finished sources, purge old cloud copies. Cheap no-op when no remote is configured. */
export async function storageTick(store: Store, cfg: Config): Promise<{ archived: number; purged: number; errors: string[] }> {
  const out = { archived: 0, purged: 0, errors: [] as string[] }; const rem = remoteOf(cfg); if (!rem || !validRemote(rem) || !(await rcloneAvailable())) return out;
  for (const v of finishedVideos(store)) { if (getEntry(store, v.id) || !existsSync(v.path)) continue; const r = await archiveVideo(store, cfg, v.id, v.path); if (r.ok) out.archived++; else { out.errors.push(`video ${v.id}: ${r.detail}`); warn('cloud archive failed', { video: v.id, detail: r.detail }); } }
  if (cfg.storage.purgeAfterDays > 0) for (const r of store.all<{ k: string; v: string }>(`SELECT k, v FROM kv WHERE k LIKE 'cloud:video:%'`)) {
    try { const e = JSON.parse(r.v) as Entry; if (e.purged || !e.doneAt || Date.now() - Date.parse(e.doneAt) < cfg.storage.purgeAfterDays * 86_400_000) continue; const p = await run('rclone', ['purge', e.remote], { timeoutMs: 10 * 60_000 }); if (p.code === 0) { e.purged = true; store.exec('UPDATE kv SET v=? WHERE k=?', JSON.stringify(e), r.k); out.purged++; } } catch { /* next tick */ }
  }
  return out;
}
export function storageStatus(store: Store, cfg: Config) {
  const rows = store.all<{ v: string }>(`SELECT v FROM kv WHERE k LIKE 'cloud:video:%'`).map((r) => { try { return JSON.parse(r.v) as Entry; } catch { return null; } }).filter((x): x is Entry => !!x);
  return { remote: remoteOf(cfg), deleteLocal: cfg.storage.deleteLocal, purgeAfterDays: cfg.storage.purgeAfterDays, archived: rows.filter((x) => !x.purged).length, purged: rows.filter((x) => x.purged).length, waiting: finishedVideos(store).filter((v) => !getEntry(store, v.id)).length };
}
