import { join } from 'node:path';
import type { Store, Job } from './db.ts';
import { enqueue, claim, completeJob, failJob } from './db.ts';
import type { Config } from './config.ts';
import { analyzeVideo } from './analysis/analyzer.ts';
import { renderCandidate } from './edit/render.ts';
import { buildMetadata, validateMetadata } from './seo/metadata.ts';
import { makeThumbnail } from './seo/thumbnail.ts';
import { info, error } from './util/log.ts';

/** Seed jobs for anything not yet processed. Keys make it idempotent: re-running never duplicates work. */
export function seedJobs(store: Store, cfg: Config): number {
  let n = 0;
  for (const v of store.all<{ id: number }>(`SELECT id FROM videos WHERE state IN ('NEW','ANALYZING')`)) n += enqueue(store, 'analyze', `analyze:${v.id}`) ? 1 : 0;
  for (const c of store.all<{ id: number }>(`SELECT id FROM candidates WHERE status='candidate' ORDER BY score DESC`)) n += enqueue(store, 'render', `render:${c.id}`) ? 1 : 0;
  for (const c of store.all<{ id: number }>(`SELECT id FROM clips WHERE metadata_json IS NULL AND edited_path IS NOT NULL`)) n += enqueue(store, 'meta', `meta:${c.id}`) ? 1 : 0;
  void cfg;
  return n;
}

async function handle(store: Store, cfg: Config, job: Job): Promise<void> {
  const id = Number(job.key.split(':')[1]);
  if (job.kind === 'analyze') { await analyzeVideo(store, cfg, id); seedJobs(store, cfg); return; }
  if (job.kind === 'render') {
    const meta = store.get<{ category: string; transcript: string; language: string; video_id: number }>('SELECT category, transcript, language, video_id FROM candidates WHERE id=?', id)!;
    const md = buildMetadata({ transcript: meta.transcript ?? '', category: meta.category, language: meta.language ?? 'unknown' });
    const r = await renderCandidate(store, cfg, id, { title: md.titles[0]?.replace(/ ?#\w+/g, '') ?? null });
    enqueue(store, 'meta', `meta:${r.clipId}`); return;
  }
  if (job.kind === 'meta') {
    const row = store.get<{ id: number; candidate_id: number; edited_path: string; output_id: string }>('SELECT id, candidate_id, edited_path, output_id FROM clips WHERE id=?', id)!;
    const cand = store.get<{ category: string; transcript: string; language: string; start_sec: number; end_sec: number }>('SELECT category, transcript, language, start_sec, end_sec FROM candidates WHERE id=?', row.candidate_id)!;
    const md = buildMetadata({ transcript: cand.transcript ?? '', category: cand.category, language: cand.language ?? 'unknown' });
    const errs = validateMetadata(md);
    if (errs.length) throw new Error(`metadata invalid: ${errs.join('; ')}`);
    const thumb = await makeThumbnail(row.edited_path, join(cfg.dirs.thumbnails, `${row.output_id}.jpg`), md.thumbnailText);
    store.exec('UPDATE clips SET metadata_json=?, thumbnail_path=? WHERE id=?', JSON.stringify({ ...md, thumbnailOk: !!thumb }), thumb?.path ?? null, row.id);
    return;
  }
  throw new Error(`unknown job kind ${job.kind}`);
}

/** Process jobs until the queue is empty (or `maxJobs`). Crash-safe: leases expire and jobs are re-claimed. */
export async function work(store: Store, cfg: Config, o: { maxJobs?: number; shouldStop?: () => boolean } = {}): Promise<{ done: number; failed: number; dead: number }> {
  let done = 0, failed = 0, dead = 0;
  for (let i = 0; i < (o.maxJobs ?? 1e9); i++) {
    if (o.shouldStop?.()) break; // graceful shutdown between jobs; in-flight leases expire and are re-claimed after restart
    const job = claim(store);
    if (!job) break;
    try { await handle(store, cfg, job); completeJob(store, job.id); done++; info('job done', { kind: job.kind, key: job.key }); }
    catch (e) {
      const st = failJob(store, job, (e as Error).message, cfg.resources.jobMaxAttempts);
      failed++; if (st === 'DEAD') dead++;
      error('job failed', { key: job.key, attempt: job.attempts, state: st, err: (e as Error).message.slice(0, 200) });
      if (/LOW_DISK/.test((e as Error).message)) break; // stop hard on disk pressure
    }
  }
  return { done, failed, dead };
}
