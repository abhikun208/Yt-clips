import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import { info, warn } from '../util/log.ts';

/** Database safety net: (1) a daily automatic snapshot (last 7 kept, in backups/auto/ - never mixed with manual ones), (2) a quick integrity check so silent corruption is noticed on the same day. Secrets/tokens are never copied. */
export function integrity(store: Store): { ok: boolean; detail: string } {
  try { const rows = store.all<Record<string, string>>('PRAGMA quick_check'); const first = String(Object.values(rows[0] ?? {})[0] ?? 'no answer'); return { ok: first === 'ok', detail: first }; } catch (e) { return { ok: false, detail: (e as Error).message.slice(0, 120) }; }
}
export function autoBackup(store: Store, dataDir: string, now = new Date(), keep = 7): { made: string | null; kept: number; integrity: { ok: boolean; detail: string } } {
  const day = now.toISOString().slice(0, 10); const dir = join(dataDir, 'backups', 'auto'); mkdirSync(dir, { recursive: true });
  const chk = integrity(store); let made: string | null = null;
  const last = store.get<{ v: string }>(`SELECT v FROM kv WHERE k='backup:auto:last'`)?.v;
  if (last !== day) {
    if (!chk.ok) { warn('db integrity check FAILED - NOT overwriting good backups with a damaged copy', { detail: chk.detail }); }
    else { const name = `auto-${day}.db`; try { store.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`); made = name; store.exec(`INSERT INTO kv(k,v) VALUES('backup:auto:last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, day); info('daily db backup', { name }); } catch (e) { warn('daily db backup failed', { err: (e as Error).message.slice(0, 120) }); } }
  }
  const files = readdirSync(dir).filter((f) => /^auto-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) { try { unlinkSync(join(dir, old)); } catch { /* keep going */ } }
  void statSync; return { made, kept: Math.min(files.length, keep), integrity: chk };
}
