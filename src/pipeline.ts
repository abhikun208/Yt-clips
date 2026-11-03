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
  if (job.kind === 'rerender') { if (!store.get('SELECT 1 FROM clips WHERE id=?', id)) return; await rerenderClip(store, cfg, id, job.payload_json ? JSON.parse(job.payload_json) : {}); return; }
  throw new Error(`unknown job kind ${job.kind}`);
}

/** Backpressure / circuit breaker: when most recent jobs fail (network down, key dead, disk), retrying every job only burns CPU and poisons the queue. After >=8 outcomes in 10 min with >50% failures the queue pauses for 10 min, the owner is told once, and the doctor's revivals stay quiet meanwhile. */
const recent: { t: number; ok: boolean }[] = [];
export const resetBreaker = () => { recent.length = 0; };
const pausedUntil = (store: Store): number => Number(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='queue:paused_until'`)?.v ?? 0);
export const queuePaused = (store: Store, now = Date.now()): boolean => pausedUntil(store) > now;
function noteOutcome(store: Store, cfg: Config, ok: boolean): boolean {
  const now = Date.now(); recent.push({ t: now, ok }); while (recent.length && now - recent[0]!.t > 10 * 60_000) recent.shift();
  const level = Number(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='queue:breaker_level'`)?.v ?? 0);
  if (ok && level > 0 && recent.filter((x) => x.ok).length >= 3) store.exec(`UPDATE kv SET v='0' WHERE k='queue:breaker_level'`); // recovered: three successes close the breaker for good
  const bad = recent.filter((x) => !x.ok).length;
  const probing = level > 0 && recent.length < 8; // half-open: after a pause the next failures re-open it quickly (3 failures in a row), not after 8 more
  const trip = (recent.length >= 8 && bad / recent.length > 0.5) || (probing && !ok && recent.length >= 3 && recent.slice(-3).every((x) => !x.ok));
  if (trip) {
    const mins = Math.min(120, 10 * 2 ** level); // 10, 20, 40, 80, 120 min: a provider that stays down is not hammered
    store.exec(`INSERT INTO kv(k,v) VALUES('queue:paused_until',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, String(now + mins * 60_000)); store.exec(`INSERT INTO kv(k,v) VALUES('queue:breaker_level',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, String(level + 1)); recent.length = 0;
    error('queue paused (circuit breaker)', { failed: bad, minutes: mins }); void notify(store, cfg, `breaker:${Math.floor(now / 3600_000)}`, `Queue ${mins} minute ke liye ruk gaya: zyaadatar jobs fail ho rahe hain (internet/key/disk check karo). Apne aap dobara try karega; jo job chal rahe the wo poore hote hain.`).catch(() => undefined); return true;
  }
  return false;
}

/** Process jobs until the queue is empty (or `maxJobs`). Crash-safe: leases expire and jobs are re-claimed. */
export async function work(store: Store, cfg: Config, o: { maxJobs?: number; shouldStop?: () => boolean } = {}): Promise<{ done: number; failed: number; dead: number }> {
  let done = 0, failed = 0, dead = 0, started = 0, halt = false;
  if (queuePaused(store)) return { done, failed, dead }; // breaker is open: let things recover first
  const max = o.maxJobs ?? 1e9; const lanes = Math.max(1, Math.min(4, Math.floor(cfg.resources.renderConcurrency || 1)));
  // N lanes pull from the same lease-based queue (claim() is a single synchronous SQLite write, so two lanes never get the same job)
  const lane = async () => {
    while (!halt && started < max) {
      if (o.shouldStop?.()) break; // graceful shutdown between jobs; in-flight leases expire and are re-claimed after restart
      const job = claim(store);
      if (!job) break;
      started++;
      try { await handle(store, cfg, job); completeJob(store, job.id); done++; info('job done', { kind: job.kind, key: job.key }); noteOutcome(store, cfg, true); }
      catch (e) {
        const st = failJob(store, job, (e as Error).message, cfg.resources.jobMaxAttempts);
        failed++; if (noteOutcome(store, cfg, false)) halt = true; if (st === 'DEAD') { dead++; void notify(store, cfg, `dead:${job.key}`, `Job ${job.key} ${job.attempts} koshish ke baad ruk gaya: ${(e as Error).message.slice(0, 160)}`).catch(() => undefined); } // dead-letter: stays visible (UI/doctor) and the owner is told once
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
