import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Non-destructive migrations: only CREATE ... IF NOT EXISTS / ADD COLUMN. Never DROP/TRUNCATE. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, uri TEXT NOT NULL UNIQUE, title TEXT,
    authorized INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER REFERENCES sources(id), path TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE, size INTEGER, duration REAL, width INTEGER, height INTEGER, fps REAL, has_audio INTEGER,
    state TEXT NOT NULL DEFAULT 'NEW', intro_end REAL, outro_start REAL, analysis_path TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL REFERENCES videos(id),
    start_sec REAL NOT NULL, end_sec REAL NOT NULL, score REAL NOT NULL, category TEXT, reason TEXT, hook TEXT,
    transcript TEXT, language TEXT, confidence REAL, signals_json TEXT, status TEXT NOT NULL DEFAULT 'candidate',
    exclusion_reason TEXT, fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL REFERENCES candidates(id), output_id TEXT NOT NULL UNIQUE,
    raw_path TEXT, edited_path TEXT, manifest_path TEXT, thumbnail_path TEXT, metadata_json TEXT, qc_json TEXT, qc_pass INTEGER,
    state TEXT NOT NULL DEFAULT 'RENDERED', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clip_id INTEGER NOT NULL REFERENCES clips(id), platform TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'READY_FOR_QC', idempotency_key TEXT NOT NULL UNIQUE, remote_id TEXT, visibility TEXT NOT NULL DEFAULT 'private',
    scheduled_at TEXT, error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS state_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
    note TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, run_after INTEGER NOT NULL DEFAULT 0, last_error TEXT, payload_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, remote_id TEXT NOT NULL, text TEXT NOT NULL, class TEXT,
    draft TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(platform, remote_id));
  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, published_at TEXT NOT NULL, views REAL, avg_view_pct REAL, ctr REAL, note TEXT,
    UNIQUE(platform, published_at));
  CREATE INDEX IF NOT EXISTS idx_cand_video ON candidates(video_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, run_after);
  `,
];

export type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  private migrate(): void {
    const cur = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = cur; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version=${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  get<T = Row>(sql: string, ...p: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...p) as T | undefined; }
  all<T = Row>(sql: string, ...p: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...p) as T[]; }
  exec(sql: string, ...p: (string | number | null)[]): { changes: number; lastId: number } {
    const r = this.db.prepare(sql).run(...p);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  logState(entity: string, id: number, from: string | null, to: string, note?: string): void {
    this.exec('INSERT INTO state_log(entity, entity_id, from_state, to_state, note) VALUES (?,?,?,?,?)', entity, id, from, to, note ?? null);
  }
  close(): void { this.db.close(); }
}

// ---- Persistent job queue (lease + backoff). No Redis needed. ----
export interface Job { id: number; kind: string; key: string; attempts: number; payload_json: string | null }

export function enqueue(s: Store, kind: string, key: string, payload?: unknown): boolean {
  return s.exec('INSERT OR IGNORE INTO jobs(kind, key, payload_json) VALUES (?,?,?)', kind, key, payload ? JSON.stringify(payload) : null).changes > 0;
}

/** Claim next runnable job (PENDING/FAILED-retry with backoff elapsed, or expired lease). */
export function claim(s: Store, leaseMs = 15 * 60_000, now = Date.now()): Job | undefined {
  return s.tx(() => {
    const j = s.get<Job>(
      `SELECT id, kind, key, attempts, payload_json FROM jobs
       WHERE (state IN ('PENDING','RETRY') AND run_after <= ?) OR (state='RUNNING' AND lease_until < ?)
       ORDER BY id LIMIT 1`, now, now);
    if (!j) return undefined;
    s.exec(`UPDATE jobs SET state='RUNNING', lease_until=?, attempts=attempts+1, updated_at=datetime('now') WHERE id=?`, now + leaseMs, j.id);
    return { ...j, attempts: j.attempts + 1 };
  });
}
export function completeJob(s: Store, id: number): void { s.exec(`UPDATE jobs SET state='DONE', lease_until=NULL, last_error=NULL, updated_at=datetime('now') WHERE id=?`, id); }

/** Exponential backoff with jitter; moves to DEAD after maxAttempts (kept for inspection, never deleted). */
export function failJob(s: Store, job: Job, err: string, maxAttempts: number, now = Date.now(), rnd: () => number = Math.random): 'RETRY' | 'DEAD' {
  const state = job.attempts >= maxAttempts ? 'DEAD' : 'RETRY';
  const base = Math.min(30 * 60_000, 5_000 * 2 ** (job.attempts - 1));
  const delay = Math.round(base * (0.75 + rnd() * 0.5));
  s.exec(`UPDATE jobs SET state=?, run_after=?, lease_until=NULL, last_error=?, updated_at=datetime('now') WHERE id=?`, state, now + delay, err.slice(0, 2000), job.id);
  return state;
}
