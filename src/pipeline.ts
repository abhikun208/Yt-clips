import { join } from 'node:path';
import { repairVideo, DECODE_ERR } from './ops/repair.ts';
import { realHook } from './seo/hook.ts';
import type { Store, Job } from './db.ts';
import { enqueue, claim, completeJob, failJob } from './db.ts';
import type { Config } from './config.ts';
import { analyzeVideo } from './analysis/analyzer.ts';
import { renderCandidate } from './edit/render.ts';
import { loadTranscript, type Cue } from './analysis/transcript.ts';
import { metaForClip } from './seo/clipmeta.ts';
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
    const hook = cfg.edit.hookTitle !== true ? null : realHook(meta.transcript ?? '', hk); // null => render derives one from the clip's own speech, or burns nothing
    const r = await renderCandidate(store, cfg, id, { ...(cfg.edit.hookTitle !== true ? { title: null } : hook ? { title: hook } : {}), ...(ch.config.captionPreset ? { captionPreset: ch.config.captionPreset } : {}) });
    enqueue(store, 'meta', `meta:${r.clipId}`); return;
  }
  if (job.kind === 'meta') { if (!store.get('SELECT 1 FROM clips WHERE id=?', id)) return; await metaForClip(store, cfg, id); return; } // clip deleted by the owner meanwhile: nothing to do
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
        if (job.kind === 'render' && DECODE_ERR.test((e as Error).message)) { // undecodable source (AV1/corrupt): fetch it again as H.264 right now (max once per 6 h per video), then the job is re-queued
          const vid = store.get<{ video_id: number }>('SELECT video_id FROM candidates WHERE id=?', Number(job.key.split(':')[1]))?.video_id; const rk = `repair:auto:${vid}`; const last = Number(store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', rk)?.v ?? 0);
          if (vid && Date.now() - last > 6 * 3600_000) { store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, rk, String(Date.now())); const rp = await repairVideo(store, cfg, vid).catch((x) => ({ ok: false, note: (x as Error).message })); info('auto-repair of source', { videoId: vid, ok: rp.ok, note: rp.note }); }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return { done, failed, dead };
}
