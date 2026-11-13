import { mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run } from '../util/proc.ts';
import { ingestLocal } from '../sources/local.ts';
import { info, warn } from '../util/log.ts';

/**
 * Live stream auto-capture (opt-in per source: sources.meta_json.watchLive = true).
 * While a watched channel is live, 5-minute chunks are recorded and fed into the normal Analyze -> Render -> Publish pipeline
 * as ordinary videos (that flow is NOT changed). Chunks are tagged kv `live:video:<id>` so the scheduler can cap live uploads per hour.
 * Every skip / failure logs a clear reason (rate-limited so a 30 s poll cannot flood the log). Never run against real YouTube from the sandbox: UNVERIFIED on a real stream.
 */
export interface LiveDeps {
  /** is this URL live right now? returns { live, reason } (reason when not live or on error) */
  probe(url: string): Promise<{ live: boolean; reason: string; error?: boolean }>;
  /** record up to `seconds` of the stream into `out`; resolves bytes written (0 = nothing) */
  record(url: string, out: string, seconds: number): Promise<{ ok: boolean; reason: string }>;
  ingest(file: string, title: string, sourceId: number, channelId: number | null): Promise<number | null>;
  now(): number;
}

const kvGet = (s: Store, k: string): string | null => s.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v ?? null;
const kvSet = (s: Store, k: string, v: string): void => { s.exec('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v); };
const kvDel = (s: Store, k: string): void => { s.exec('DELETE FROM kv WHERE k=?', k); };

/** `https://youtube.com/@x/videos` -> `https://youtube.com/@x/live` */
export const liveUrl = (uri: string): string => uri.replace(/\/(videos|shorts|streams|live)\/?$/, '').replace(/\/$/, '') + '/live';

export const realDeps = (cfg: Config): LiveDeps => ({
  now: () => Date.now(),
  async probe(url) {
    const r = await run('yt-dlp', ['--dump-json', '--no-warnings', '--playlist-items', '1', url], { timeoutMs: 60_000 });
    if (r.code === 0) { try { const j = JSON.parse(r.stdout.split('\n')[0]) as { is_live?: boolean; live_status?: string }; return j.is_live || j.live_status === 'is_live' ? { live: true, reason: 'live' } : { live: false, reason: 'channel abhi live nahi hai' }; } catch { return { live: false, reason: 'yt-dlp output samajh nahi aaya', error: true }; } }
    const t = r.stderr.trim().slice(-200);
    if (/not currently live|does not have a live|no live|offline|not live/i.test(t)) return { live: false, reason: 'channel abhi live nahi hai' };
    return { live: false, reason: `live check fail (internet/yt-dlp): ${t || 'timeout'}`, error: true };
  },
  async record(url, out, seconds) {
    const g = await run('yt-dlp', ['-g', '-f', 'b[height<=720]/b', '--no-warnings', url], { timeoutMs: 60_000 });
    const stream = g.stdout.split('\n').map((x) => x.trim()).find((x) => /^https?:\/\//.test(x));
    if (g.code !== 0 || !stream) return { ok: false, reason: `stream URL nahi mila: ${g.stderr.trim().slice(-160) || 'khali'}` };
    const f = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', stream, '-t', String(seconds), '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out], { timeoutMs: (seconds + 90) * 1000 });
    // a dropped connection ends ffmpeg early: whatever was written is still a usable chunk (judged by the caller via its size)
    return { ok: existsSync(out) && statSync(out).size > 0, reason: f.code === 0 ? 'ok' : `ffmpeg ruka (${f.timedOut ? 'timeout' : f.stderr.trim().slice(-120) || 'code ' + f.code})` };
  },
  async ingest(file, title, sourceId, channelId) { const r = await ingestLocal(store0(cfg), cfg, file, { authorized: true, title, sourceId, ...(channelId ? { channelId } : {}) }); return r.videoId; },
});
// ingest needs the store: bound lazily in liveTick (keeps LiveDeps small for fakes)
let boundStore: Store | null = null;
const store0 = (_cfg: Config): Store => { if (!boundStore) throw new Error('live store not bound'); return boundStore; };

const lastLog = new Map<string, number>();
/** log once per `everyMs` per key so a 30 s poll cannot flood the log */
function say(key: string, level: 'info' | 'warn', msg: string, data: Record<string, unknown>, every = 10 * 60_000): void {
  const n = Date.now(); if (n - (lastLog.get(key) ?? 0) < every) return; lastLog.set(key, n);
  (level === 'warn' ? warn : info)(msg, data);
}

const busy = new Set<number>(); // sources with a capture in flight (capture runs in the background so the worker loop never blocks 5 min)
const lastCheck = new Map<number, number>();

export interface LiveResult { checked: number; capturing: number; started: number; chunks: number; skipped: Record<string, number> }
const liveCfg = (cfg: Config) => ({ check: Math.max(30, cfg.automation.liveCheckSeconds ?? 30), chunk: Math.min(1800, Math.max(60, cfg.automation.liveChunkSeconds ?? 300)), maxPerHour: cfg.automation.liveMaxUploadsPerHour ?? 2 });

async function captureLoop(store: Store, cfg: Config, deps: LiveDeps, src: { id: number; uri: string; channel_id: number | null }): Promise<void> {
  const lc = liveCfg(cfg); const dir = join(cfg.dirs.tmp, `live_${src.id}`); mkdirSync(dir, { recursive: true });
  let fails = 0;
  try {
    for (;;) {
      const p = await deps.probe(liveUrl(src.uri));
      if (!p.live) { // stream ended (or internet dropped: the state is kept and a later tick resumes)
        if (p.error) { fails++; say(`lerr:${src.id}`, 'warn', 'live: check fail, dobara koshish', { source: src.id, reason: p.reason, fails }, 60_000); if (fails < 6) { await sleepMs(Math.min(60_000, 5_000 * fails)); continue; } }
        else info('live: stream khatam, capture band', { source: src.id });
        break;
      }
      fails = 0;
      const n = Number(kvGet(store, `live:seq:${src.id}`) ?? 0) + 1; const out = join(dir, `live_${src.id}_${deps.now()}_${n}.mp4`);
      const rec = await deps.record(liveUrl(src.uri), out, lc.chunk);
      const size = existsSync(out) ? statSync(out).size : 0;
      if (!rec.ok || size < 200_000) { fails++; say(`rec:${src.id}`, 'warn', 'live: chunk record nahi hua', { source: src.id, reason: rec.reason, bytes: size, fails }, 60_000); rmSync(out, { force: true }); if (fails >= 6) break; await sleepMs(Math.min(60_000, 5_000 * fails)); continue; }
      kvSet(store, `live:seq:${src.id}`, String(n));
      try { const vid = await deps.ingest(out, `[LIVE] ${new Date(deps.now()).toISOString().slice(0, 16).replace('T', ' ')} #${n}`, src.id, src.channel_id); if (vid) { kvSet(store, `live:video:${vid}`, '1'); info('live: chunk analyze queue me gaya', { source: src.id, video: vid, bytes: size, partial: !rec.ok || rec.reason !== 'ok' }); } }
      catch (e) { warn('live: chunk ingest fail', { source: src.id, err: (e as Error).message }); }
      finally { rmSync(out, { force: true }); }
    }
  } finally { // cleanup: leftover partial chunks of an ended / aborted capture
    try { for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true }); rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    busy.delete(src.id);
  }
}
let sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const _setSleep = (f: (ms: number) => Promise<void>): void => { sleepMs = f; };

/** Called every worker cycle; cheap (per-source check interval). Starts a background capture per live source. Returns immediately. */
export async function liveTick(store: Store, cfg: Config, deps: LiveDeps = realDeps(cfg), opts: { awaitCaptures?: boolean } = {}): Promise<LiveResult> {
  boundStore = store;
  const r: LiveResult = { checked: 0, capturing: 0, started: 0, chunks: 0, skipped: {} };
  const skip = (why: string): void => { r.skipped[why] = (r.skipped[why] ?? 0) + 1; };
  const lc = liveCfg(cfg); const tasks: Promise<void>[] = [];
  for (const s of store.all<{ id: number; uri: string; channel_id: number | null; meta_json: string | null }>(`SELECT id, uri, channel_id, meta_json FROM sources WHERE kind='youtube_channel' AND status='active' AND authorized=1`)) {
    let m: { watchLive?: boolean } = {}; try { m = JSON.parse(s.meta_json || '{}'); } catch { /* ignore */ }
    if (!m.watchLive) continue;
    if (busy.has(s.id)) { r.capturing++; continue; }
    if (deps.now() - (lastCheck.get(s.id) ?? 0) < lc.check * 1000) { skip('interval'); continue; }
    lastCheck.set(s.id, deps.now()); r.checked++;
    const p = await deps.probe(liveUrl(s.uri));
    if (!p.live) { skip(p.error ? 'check_error' : 'offline'); if (p.error) say(`probe:${s.id}`, 'warn', 'live: check nahi ho paya', { source: s.id, reason: p.reason }); continue; }
    busy.add(s.id); r.started++; info('live: stream mili, 5-min chunk capture shuru', { source: s.id, chunkSec: lc.chunk });
    tasks.push(captureLoop(store, cfg, deps, s).catch((e) => { warn('live: capture crash', { source: s.id, err: (e as Error).message }); busy.delete(s.id); }));
  }
  if (opts.awaitCaptures) await Promise.all(tasks);
  return r;
}

/** SQL fragment: is this clip (alias `v` = videos) a live-captured one */
export const LIVE_VIDEO_SQL = `EXISTS (SELECT 1 FROM kv WHERE k='live:video:'||v.id)`;

/** How many more live-captured clips may be queued for upload now (max N per rolling hour; counts uploads touched in the last hour). */
export function liveBudget(store: Store, cfg: Config): number {
  const used = store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM uploads u JOIN clips c ON c.id=u.clip_id JOIN candidates k ON k.id=c.candidate_id JOIN videos v ON v.id=k.video_id WHERE ${LIVE_VIDEO_SQL} AND u.created_hint > datetime('now','-1 hour')`.replace('u.created_hint', 'u.updated_at'))?.n ?? 0;
  return Math.max(0, liveCfg(cfg).maxPerHour - used);
}
export { kvDel as _kvDel };
