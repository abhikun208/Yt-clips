import { join } from 'node:path';
import type { Store, Job } from './db.ts';
import { enqueue, claim, completeJob, failJob } from './db.ts';
import type { Config } from './config.ts';
import { analyzeVideo } from './analysis/analyzer.ts';
import { renderCandidate } from './edit/render.ts';
import { buildMetadata, validateMetadata } from './seo/metadata.ts';
import { llmMetadata } from './seo/llm.ts';
import { llmChain } from './ai/settings.ts';
import { makeThumbnail } from './seo/thumbnail.ts';
import { info, error } from './util/log.ts';
import { rerenderClip } from './review/review.ts';
import { notify } from './notify.ts';
import { channelOfVideo, channelOfClip, type Channel } from './channels.ts';
/** Owner-configured per-channel branding for the SEO step (links come ONLY from config; never invented). */
const chMeta = (ch: Channel) => ({ channelName: ch.name, ownerLinks: ch.config.links, hashtagsExtra: ch.config.hashtags });

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
    const hk = store.get<{ hook: string | null }>('SELECT hook FROM candidates WHERE id=?', id)?.hook ?? undefined;
    const ch = channelOfVideo(store, meta.video_id);
    const md = buildMetadata({ transcript: meta.transcript ?? '', category: meta.category, language: meta.language ?? ch.config.language ?? 'unknown', hook: hk, ...chMeta(ch) });
    const r = await renderCandidate(store, cfg, id, { title: md.titles[0]?.replace(/ ?#\w+/g, '') ?? null, ...(ch.config.captionPreset ? { captionPreset: ch.config.captionPreset } : {}) });
    enqueue(store, 'meta', `meta:${r.clipId}`); return;
  }
  if (job.kind === 'meta') {
    const row = store.get<{ id: number; candidate_id: number; edited_path: string; output_id: string }>('SELECT id, candidate_id, edited_path, output_id FROM clips WHERE id=?', id)!;
    const cand = store.get<{ category: string; transcript: string; language: string; start_sec: number; end_sec: number; hook: string | null }>('SELECT category, transcript, language, start_sec, end_sec, hook FROM candidates WHERE id=?', row.candidate_id)!;
    let md = buildMetadata({ transcript: cand.transcript ?? '', category: cand.category, language: cand.language ?? 'unknown', hook: cand.hook ?? undefined, ...chMeta(channelOfClip(store, row.id)) });
    if (cand.transcript) for (const llm of llmChain(cfg)) { const r = await llmMetadata(md, cand.transcript, { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model }); if (r.source === 'llm') { md = r; break; } md = r; }
    const errs = validateMetadata(md);
    if (errs.length) throw new Error(`metadata invalid: ${errs.join('; ')}`);
    const thumb = await makeThumbnail(row.edited_path, join(cfg.dirs.thumbnails, `${row.output_id}.jpg`), md.thumbnailText);
    store.exec('UPDATE clips SET metadata_json=?, thumbnail_path=? WHERE id=?', JSON.stringify({ ...md, thumbnailOk: !!thumb }), thumb?.path ?? null, row.id);
    void notify(store, cfg, `clip:${row.id}`, `Clip ready for review: ${md.titles[0] ?? row.output_id} (${channelOfClip(store, row.id).name}). Dashboard → Clips.`);
    return;
  }
  if (job.kind === 'rerender') { await rerenderClip(store, cfg, id, job.payload_json ? JSON.parse(job.payload_json) : {}); return; }
  throw new Error(`unknown job kind ${job.kind}`);
}

/** Process jobs until the queue is empty (or `maxJobs`). Crash-safe: leases expire and jobs are re-claimed. */
export async function work(store: Store, cfg: Config, o: { maxJobs?: number; shouldStop?: () => boolean } = {}): Promise<{ done: number; failed: number; dead: number }> {
  let done = 0, failed = 0, dead = 0, started = 0, halt = false;
  const max = o.maxJobs ?? 1e9; const lanes = Math.max(1, Math.min(4, Math.floor(cfg.resources.renderConcurrency || 1)));
  // N lanes pull from the same lease-based queue (claim() is a single synchronous SQLite write, so two lanes never get the same job)
  const lane = async () => {
    while (!halt && started < max) {
      if (o.shouldStop?.()) break; // graceful shutdown between jobs; in-flight leases expire and are re-claimed after restart
      const job = claim(store);
      if (!job) break;
      started++;
      try { await handle(store, cfg, job); completeJob(store, job.id); done++; info('job done', { kind: job.kind, key: job.key }); }
      catch (e) {
        const st = failJob(store, job, (e as Error).message, cfg.resources.jobMaxAttempts);
        failed++; if (st === 'DEAD') dead++;
        error('job failed', { key: job.key, attempt: job.attempts, state: st, err: (e as Error).message.slice(0, 200) });
        if (/LOW_DISK/.test((e as Error).message)) halt = true; // stop hard on disk pressure
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return { done, failed, dead };
}
