import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createWriteStream, createReadStream, existsSync, statSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual, randomUUID, randomBytes, createHash } from 'node:crypto';
import { join, basename, resolve, sep } from 'node:path';
import { Store } from '../db.ts';
import { loadConfig, updateOwnerConfig, type Config } from '../config.ts';
import { ingestLocal } from '../sources/local.ts';
import { seedJobs, work, queuePaused } from '../pipeline.ts';
import { whyReport } from '../diagnose.ts';
import { notify } from '../notify.ts';
import { bootstrap as bootstrapTools } from '../ops/bootstrap.ts';
import { recordClaim, claimSummary, type ClaimKind } from '../publish/claims.ts';
import { selfcareTick } from '../ops/selfcare.ts';
import { runDoctor, lastDoctor as lastDoctor_ } from '../ops/doctor.ts';
import { analyzeVideo, isLengthBucket, type LengthBucket } from '../analysis/analyzer.ts';
import { liveTick } from '../watcher/live-monitor.ts';
import { addYoutubeSource, parseRange, pollSources, ytdlpAvailable } from '../sources/youtube.ts';
import { PRESETS, getPreset } from '../edit/captionPresets.ts';
import { presetPreview } from '../edit/preview.ts';
import { checkDisk, freeMb } from '../util/disk.ts';
import { recentLogs, logsSince, info, warn, error } from '../util/log.ts';
import { loadTranscript, applyCueEdits, type CueEdit } from '../analysis/transcript.ts';
import { startAuth, handleCallback, saveAppCreds, appCreds, type SocialApp } from '../publish/socialOauth.ts';
import { aiStatus, saveAi, sttCreds, llmChain, llmSlot, SLOT_LIST } from '../ai/settings.ts';
import { which } from '../util/proc.ts';
import { reviewClip, editClipMeta, setThumbnailFrame, exportPackage } from '../review/review.ts';
import { enqueue } from '../db.ts';
import { UI_HTML } from './ui.ts';
import { STUDIO_HTML, MANIFEST, SW, iconPng } from '../studio/assets.ts';
import { handleStudio } from '../studio/routes.ts';
import { resumeStudio, type Deps as StudioDeps } from '../studio/service.ts';
import { isPace } from '../edit/pace.ts';
import { startWebAuth, finishWebAuth, finishPaste, identityOf } from '../publish/webauth.ts';
import { metaCanPublish, metaPerms } from '../publish/meta.ts';
import { storageTick, storageStatus, testRemote, listRemotes, rcloneAvailable, validRemote } from '../storage/cloud.ts';
import { localReport } from '../localcheck.ts';
import { pickLocal } from '../analysis/localStt.ts';
import { applyEnvKeys, envStatus } from '../ai/envkeys.ts';
import { dotEnvInfo } from '../env-boot.ts';
import { autoSetup, autoFix, saveProviderKey, CATALOG, slotFor } from '../ai/autodetect.ts';
import { detectLocalEngines, testLocal, cppModelPath, voiceStudioUrl, type LocalEngineId } from '../analysis/localStt.ts';
import { listModels, testConnection, lastResults, knownTargets } from '../connections.ts';
import { channelVideos, optimizeAccount, storedAccountKit, remetaClips, advance, queueUpload, listUploads, youtubeStatus, youtubeConnectStart, youtubeConnectPoll, analyticsProviders, saveTokenFor, platformStatus, automationTick, collectYoutubeComments, postComment, secretsFor, collectRetention, learnedCategoryPrior } from '../publish/service.ts';
import { setCommentStatus } from '../comments/comments.ts';
import { importAnalyticsCsv, planFromStore, hourStats } from '../schedule/analytics.ts';
import { collectAnalytics, analyticsSummary } from '../analytics/collect.ts';
import { titleTestTick, funnelTick, listTitleTests } from '../publish/titletest.ts';
import { PLATFORMS, platformInfo, saveCredentials, credentialsConfigured, markPosted } from '../publish/direct.ts';
import { listChannels, getChannel, createChannel, updateChannel, scheduleFor, ALLOWED_PLATFORMS } from '../channels.ts';

export interface AppOptions { host?: string; port?: number; token?: string; dataDir?: string; autoRun?: boolean; loopSeconds?: number; maxUploadMb?: number; rootDir?: string; overrides?: Record<string, unknown>; studioDeps?: StudioDeps }
export interface App { server: Server; cfg: Config; store: Store; start(): Promise<number>; stop(): Promise<void>; runOnce(): Promise<void>; readonly running: boolean; applyEnv?(force?: boolean): Promise<unknown>; bootstrap?(): Promise<unknown> }

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const VERSION = '0.2.0';
const SESSION_MS = 30 * 24 * 3600_000;
/** Never show server paths or parser internals to a client. */
export const scrubError = (e: Error): string => e instanceof SyntaxError ? 'invalid JSON body' : e.message.replace(/(?:[A-Za-z]:)?(?:\/|\\)(?:[\w.@~ -]+(?:\/|\\))+[\w.@~ -]*/g, '<path>').slice(0, 200);
export const SEC_HEADERS: Record<string, string> = { 'x-content-type-options': 'nosniff', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };

function safeEq(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
function json(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(s);
}
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const safeName = (n: string) => basename(n).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload.mp4';
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip' };

/** First deploy without YT_CLIPS_TOKEN: make a random one once, keep it in the data dir (survives restarts) and print it so the owner can log in. */
const AUTO_WARN = '\x1b[1;31m  WARNING: auto-token use ho raha hai. Token logs mein dikhta hai - logs share mat karo; env YT_CLIPS_TOKEN set karke restart karo (secure).\x1b[0m\n';
function autoToken(dataDir: string): string {
  const f = join(dataDir, 'auto-token.txt');
  try { const t = readFileSync(f, 'utf8').trim(); if (t.length >= 12) { console.log(`\n  LOGIN TOKEN (auto, YT_CLIPS_TOKEN set nahi tha): ${t}\n`); console.log(AUTO_WARN); return t; } } catch { /* first run */ }
  const t = randomBytes(24).toString('hex');
  try { mkdirSync(dataDir, { recursive: true }); writeFileSync(f, t + '\n', { mode: 0o600 }); } catch { /* read-only disk: token lives for this run only */ }
  console.log(`\n  LOGIN TOKEN (auto, YT_CLIPS_TOKEN set nahi tha): ${t}\n  Isko deploy logs se copy karo; permanent karna ho to env YT_CLIPS_TOKEN set karo.\n`);
  console.log(AUTO_WARN);
  return t;
}

/** Create the app (HTTP API + UI + background worker). No dependencies. Gates are NOT configurable through the API. */
export function createApp(o: AppOptions = {}): App {
  // PaaS (Render/Railway/Replit/Koyeb) set PORT and need 0.0.0.0; without HOST we used to listen on loopback only -> 'no open port' and a failed deploy.
  const host = o.host ?? process.env.HOST ?? (process.env.PORT || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.REPL_ID ? '0.0.0.0' : '127.0.0.1');
  const cfg = loadConfig(o.rootDir ?? process.cwd(), { dataDir: o.dataDir, overrides: o.overrides });
  let token = o.token ?? process.env.YT_CLIPS_TOKEN ?? '';
  if (!LOOPBACK.has(host) && !token) token = autoToken(cfg.dataDir); // no crash on a fresh deploy: a random token is made once, kept in the data dir and printed in the logs
  if (token && token.length < 12) throw new Error('YT_CLIPS_TOKEN must be at least 12 characters.');
  const store = new Store(cfg.dbPath);
  const maxUpload = (o.maxUploadMb ?? Number(process.env.MAX_UPLOAD_MB ?? 2048)) * 1024 * 1024;
  const uploadDir = join(cfg.dataDir, 'uploads'); mkdirSync(uploadDir, { recursive: true });
  const previewDir = join(cfg.dirs.tmp, 'preview');
  let chCache: { t: number; body: unknown } | null = null; let chPending: Promise<unknown[]> | null = null; let lastPoll = 0; let lastCare = 0; let lastEnvTry = Date.now(); let lastDoctor = 0; let lastAnalytics = 0; let lastComments = 0; let lastTt = 0; let running = false; let stopping = false; let timer: NodeJS.Timeout | null = null; let current: Promise<void> | null = null;
  const fails = new Map<string, { n: number; t: number }>();

  async function runOnce(): Promise<void> {
    if (running) return current ?? Promise.resolve();
    running = true;
    current = (async () => {
      try {
        if (Date.now() - lastPoll >= cfg.youtube.pollMinutes * 60_000 && store.get(`SELECT 1 FROM sources WHERE kind IN ('youtube_channel','youtube_video') AND status IN ('active','pending')`)) { lastPoll = Date.now(); const pr = await pollSources(store, cfg); if (pr.discovered || pr.downloaded || pr.failed) info('source poll', pr as unknown as Record<string, unknown>); }
        if (cfg.analytics.pollMinutes > 0 && Date.now() - lastAnalytics >= cfg.analytics.pollMinutes * 60_000) { lastAnalytics = Date.now(); const ar = await collectAnalytics(store, analyticsProviders(store, cfg)); await collectRetention(store, cfg).catch(() => null); if (ar.some((x) => x.recorded || x.error)) info('analytics collect', { results: ar } as unknown as Record<string, unknown>); }
        if (cfg.automation.titleTest || cfg.automation.funnelComment) { if (Date.now() - lastTt >= 15 * 60_000) { lastTt = Date.now(); await titleTestTick(store, cfg).catch(() => null); await funnelTick(store, cfg).catch(() => null); } }
        if (cfg.comments.pollMinutes > 0 && Date.now() - lastComments >= cfg.comments.pollMinutes * 60_000) { lastComments = Date.now(); const cr = await collectYoutubeComments(store, cfg); if (cr.newComments || cr.error) info('comments collect', cr as unknown as Record<string, unknown>); const { llmDraftReplies } = await import('../comments/comments.ts'); const { llmChain } = await import('../ai/settings.ts'); const ur = await llmDraftReplies(store, llmChain(cfg)).catch(() => null); if (ur?.upgraded) info('comment drafts written by the LLM (owner still approves)', ur); const { autoReplyTick } = await import('../publish/service.ts'); await autoReplyTick(store, cfg).catch(() => null); }
        if (Date.now() - lastEnvTry >= 30 * 60_000) { lastEnvTry = Date.now(); void applyEnvKeys(cfg).catch(() => null); } // a key that failed its live test at start-up (network blip) is retried
        if (Date.now() - lastCare >= 30 * 60_000) { lastCare = Date.now(); await selfcareTick(store, cfg).catch(() => null); } // temp GC, disk watch, orphan processes, key sentinel
        if (Date.now() - lastDoctor >= 10 * 60_000) { lastDoctor = Date.now(); const dr = await runDoctor(store, cfg).catch(() => null); if (dr && (dr.fixed || dr.manual)) info('doctor', { fixed: dr.fixed, manual: dr.manual, deferred: dr.deferred }); }
        { const lr = await liveTick(store, cfg).catch((e) => { error('live tick', { err: (e as Error).message }); return null; }); if (lr && (lr.started || lr.chunks)) info('live tick', lr as unknown as Record<string, unknown>); }
        { const tr = await automationTick(store, cfg); if (tr.queued || tr.advanced || tr.errors.length) info('automation tick', tr as unknown as Record<string, unknown>); }
        { const sr = await storageTick(store, cfg).catch(() => null); if (sr && (sr.archived || sr.purged)) info('storage tick', sr as unknown as Record<string, unknown>); }
        seedJobs(store, cfg); const r = await work(store, cfg, { shouldStop: () => stopping }); if (r.done || r.failed) info('worker cycle', r); }
      catch (e) { error('worker cycle crashed', { err: (e as Error).message }); }
      finally { running = false; }
    })();
    return current;
  }

  const authed = (req: IncomingMessage): boolean => {
    if (!token) return true; // loopback-only mode
    const h = String(req.headers.authorization ?? ''); const bearer = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-api-key'] ?? '');
    if (bearer && safeEq(bearer, token)) return true;
    const sid = sessionId(req); if (!sid) return false;
    const exp = Number(store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `session:${sid}`)?.v ?? 0); if (exp > Date.now()) return true;
    if (exp) store.exec('DELETE FROM kv WHERE k=?', `session:${sid}`); return false;
  };
  const sessionId = (req: IncomingMessage): string | null => { const ck = /(?:^|;\s*)ytc_sid=([A-Za-z0-9_-]{20,64})/.exec(String(req.headers.cookie ?? '')); return ck ? ck[1]! : null; };
  const hasCreds = (req: IncomingMessage) => !!(req.headers.authorization || req.headers['x-api-key'] || sessionId(req));
  const newSession = (): string => { const sid = randomBytes(32).toString('base64url'); store.exec(`DELETE FROM kv WHERE k LIKE 'session:%' AND CAST(v AS INTEGER) < ?`, Date.now()); store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, `session:${sid}`, String(Date.now() + SESSION_MS)); return sid; };
  const trustProxy = process.env.TRUST_PROXY === '1';
  const clientIp = (req: IncomingMessage) => { if (trustProxy) { const xf = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean); if (xf.length) return xf[xf.length - 1]!; } return req.socket.remoteAddress ?? '?'; };
  const usedCookie = (req: IncomingMessage) => !String(req.headers.authorization ?? '').startsWith('Bearer ') && !req.headers['x-api-key'];

  const publicBase = (req: IncomingMessage) => (process.env.PUBLIC_URL ?? `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host ?? '127.0.0.1'}`).replace(/\/+$/, '');
  function clipRows() {
    return store.all<{ id: number; output_id: string; edited_path: string; thumbnail_path: string | null; metadata_json: string | null; qc_pass: number | null; state: string; candidate_id: number; review: string; review_note: string | null; variant: number; qc_json: string | null }>(
      'SELECT id, output_id, edited_path, thumbnail_path, metadata_json, qc_pass, state, candidate_id, review, review_note, variant, qc_json FROM clips ORDER BY id DESC LIMIT 200').map((c) => {
      let mf: { treatments?: { dimension: string; applied: boolean; detail: string }[]; treatmentCoverage?: { applied: number; total: number }; captions?: { preset?: string; wordTiming?: string } | null } = {};
      try { const f = join(cfg.dirs.manifests, `${c.output_id}.json`); if (existsSync(f)) mf = JSON.parse(readFileSync(f, 'utf8')); } catch { /* manifest unreadable: show nothing rather than guess */ }
      let finalSec: number | null = null; try { const v = Number((JSON.parse(c.qc_json ?? '{}') as { checks?: { duration?: { value?: string | number } } }).checks?.duration?.value); if (Number.isFinite(v) && v > 0) finalSec = v; } catch { /* old clip */ }
      const md = c.metadata_json ? JSON.parse(c.metadata_json) : {}; const cand = store.get<{ start_sec: number; end_sec: number; category: string; video_id: number }>('SELECT start_sec, end_sec, category, video_id FROM candidates WHERE id=?', c.candidate_id);
      return { videoId: cand?.video_id ?? null, srcStart: cand?.start_sec ?? null, srcEnd: cand?.end_sec ?? null, review: c.review, reviewNote: c.review_note, variant: c.variant, visualChange: (mf as { visualChange?: unknown }).visualChange ?? null, thumbText: md.thumbnailText ?? null, generatedBy: md.generatedBy ?? null, seo: md.seo ?? null, viral: cand ? Math.round(((store.get<{ score: number }>('SELECT score FROM candidates WHERE id=?', c.candidate_id)?.score) ?? 0) * 100) : null, part: cand ? (store.get<{ part_no: number | null; part_total: number | null }>('SELECT part_no, part_total FROM candidates WHERE id=?', c.candidate_id) ?? null) : null, treatments: mf.treatments ?? [], coverage: mf.treatmentCoverage ?? null, captionInfo: mf.captions ?? null, id: c.id, outputId: c.output_id, title: md.title ?? null, description: md.description ?? null, tags: md.tags ?? [], qcPass: !!c.qc_pass, state: c.state, category: cand?.category ?? null, duration: finalSec ?? (cand ? cand.end_sec - cand.start_sec : 0), sourceSpan: cand ? +(cand.end_sec - cand.start_sec).toFixed(1) : 0, /* real file length (jump cuts / speed ramp make it shorter than the source span) */
        video: `/files/edited/${c.output_id}.mp4`, thumb: c.thumbnail_path ? `/files/thumb/${c.output_id}.jpg` : null, srt: existsSync(join(cfg.dataDir, 'captions', `${c.output_id}.srt`)) ? `/files/captions/${c.output_id}.srt` : null };
    });
  }

  function serveFile(req: IncomingMessage, res: ServerResponse, kind: string, name: string) {
    const dirs: Record<string, string> = { edited: cfg.dirs.editedShorts, thumb: cfg.dirs.thumbnails, captions: join(cfg.dataDir, 'captions'), export: join(cfg.dataDir, 'exports') };
    const dir = dirs[kind]; if (!dir || !/^[\w.-]+$/.test(name)) return json(res, 404, { error: 'not found' });
    const full = resolve(dir, name); if (!full.startsWith(resolve(dir) + sep) || !existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: 'not found' });
    sendPath(req, res, full, MIME[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream');
  }

  function sendPath(req: IncomingMessage, res: ServerResponse, full: string, type: string, download?: string) {
    const size = statSync(full).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    const base = { 'content-type': type, ...(download ? { 'content-disposition': `attachment; filename="${download.replace(/[^\w.-]/g, '_')}"` } : {}), 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=60' };
    if (range && (range[1] || range[2])) {
      let a = range[1] ? Number(range[1]) : size - Number(range[2]); let b = range[1] && range[2] ? Number(range[2]) : size - 1;
      if (!(a >= 0 && a < size && b >= a)) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return void res.end(); }
      b = Math.min(b, size - 1);
      res.writeHead(206, { ...base, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 });
      return void createReadStream(full, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { ...base, 'content-length': size });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(full).pipe(res);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname; const m = req.method ?? 'GET'; if (m !== 'GET' && m !== 'HEAD') chCache = null;
    res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (p === '/healthz') {
        const q = store.all<{ state: string; n: number }>('SELECT state, count(*) n FROM jobs GROUP BY state');
        return json(res, 200, { ok: true, version: VERSION, running, freeDiskMb: freeMb(cfg.dataDir), queue: Object.fromEntries(q.map((x) => [x.state, x.n])) });
      }
      if (p === '/live') return json(res, 200, { ok: true, processing: running });
      if (p === '/ready') { let dbOk = false; try { dbOk = !!store.get('SELECT 1 AS x'); } catch { dbOk = false; } const mb = freeMb(cfg.dataDir); const ok = dbOk && mb > 200; return json(res, ok ? 200 : 503, { ok, db: dbOk, freeDiskMb: mb, minFreeMb: 200 }); }
      if (p === '/metrics' && m === 'GET' && authed(req)) { // Prometheus text format, needs the token (unauthenticated requests fall through to the 401 below)
        const L: string[] = []; const g = (name: string, help: string, rows: [string, number][]) => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); for (const [lab, v] of rows) L.push(`${name}${lab} ${v}`); };
        g('ytclips_jobs', 'jobs by state', store.all<{ state: string; n: number }>('SELECT state, count(*) n FROM jobs GROUP BY state').map((x) => [`{state="${x.state}"}`, x.n]));
        g('ytclips_videos', 'videos by state', store.all<{ state: string; n: number }>('SELECT state, count(*) n FROM videos GROUP BY state').map((x) => [`{state="${x.state}"}`, x.n]));
        g('ytclips_clips', 'rendered clips', [['', store.get<{ n: number }>('SELECT count(*) n FROM clips')?.n ?? 0]]);
        g('ytclips_uploads', 'uploads by state', store.all<{ state: string; n: number }>('SELECT state, count(*) n FROM uploads GROUP BY state').map((x) => [`{state="${x.state}"}`, x.n]));
        g('ytclips_free_disk_mb', 'free disk in MB', [['', freeMb(cfg.dataDir)]]); g('ytclips_running', 'worker loop active', [['', running ? 1 : 0]]);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return void res.end(L.join('\n') + '\n'); }
      if (p === '/' && m === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS, ...(req.headers['x-forwarded-proto'] === 'https' ? { 'strict-transport-security': 'max-age=31536000' } : {}), 'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" }); return void res.end(UI_HTML); }
      if (m === 'GET' && (p === '/studio' || p === '/manifest.webmanifest' || p === '/sw.js' || p === '/icon-192.png' || p === '/icon-512.png')) { // static shell of the Studio app (no secrets: all data comes from the authenticated API)
        const hs = { ...SEC_HEADERS, ...(req.headers['x-forwarded-proto'] === 'https' ? { 'strict-transport-security': 'max-age=31536000' } : {}) };
        if (p === '/studio') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...hs, 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" }); return void res.end(STUDIO_HTML); }
        if (p === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json', ...hs }); return void res.end(MANIFEST); }
        if (p === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/', ...hs }); return void res.end(SW); }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', ...hs }); return void res.end(iconPng(p === '/icon-192.png' ? 192 : 512));
      }
      const cbm = /^\/api\/oauth\/(facebook|tiktok)\/callback$/.exec(p);
      if (cbm && m === 'GET') { // browser redirect from the provider: protected by the one-time server-side `state`, not by cookie (SameSite=Strict cookies are not sent on cross-site redirects)
        let msg = ''; try { const r = await handleCallback(store, cfg, cbm[1] as SocialApp, { code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') }, publicBase(req)); msg = `Connected: ${r.connected.join(', ')}${r.note ? ' (' + r.note + ')' : ''}`; }
        catch (e) { msg = 'Failed: ' + (e as Error).message.slice(0, 200); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return void res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;padding:24px"><p>${msg.replace(/[<>&]/g, '')}</p><p><a href="/">yt-clips kholo</a></p>`);
      }
      if (p === '/api/oauth/youtube/callback' && m === 'GET') { // Google redirect: protected by the single-use server-side `state` (works for a shared link opened on another device)
        let title = 'Failed', body = ''; try { const r = await finishWebAuth(store, cfg, { code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') }); title = 'Connected ✓'; body = r.identity ? `YouTube channel: <b>${r.identity.title.replace(/[<>&"]/g, '')}</b><br><small>ID: ${r.identity.channelId.replace(/[^\w-]/g, '')}</small>` : 'Login ho gaya (channel ka naam baad mein Test se aayega).'; }
        catch (e) { body = String((e as Error).message).slice(0, 240).replace(/[<>&]/g, ''); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); return void res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:17px system-ui;background:#0b0d14;color:#eef1f8;padding:28px;text-align:center"><h2>${title}</h2><p>${body}</p><p style="color:#98a2b8">Ab ye tab band kar sakte ho.</p>`);
      }
      const pf = /^\/pub\/([a-f0-9]{48})\.mp4$/.exec(p); // one clip, unguessable + expiring: Instagram's servers fetch this themselves (video_url)
      if (pf && (m === 'GET' || m === 'HEAD')) {
        const row = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `pubfile:${pf[1]}`); const j = row ? JSON.parse(row.v) as { file: string; exp: number } : null;
        if (!j || j.exp < Date.now() || !existsSync(j.file)) return json(res, 404, { error: 'not found' });
        const size = statSync(j.file).size; const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        const hb = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
        if (range) { const a = Number(range[1]), b = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1); if (a >= size || b < a) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return void res.end(); } res.writeHead(206, { ...hb, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 }); return m === 'HEAD' ? void res.end() : void createReadStream(j.file, { start: a, end: b }).pipe(res); }
        res.writeHead(200, { ...hb, 'content-length': size }); return m === 'HEAD' ? void res.end() : void createReadStream(j.file).pipe(res);
      }
      const ip = clientIp(req);
      const f = fails.get(ip);
      if (!authed(req)) { // lockout applies ONLY to callers that are not authenticated, and only wrong credentials count (a browser that has not logged in yet is not an attack)
        if (f && f.n >= 10 && Date.now() - f.t < 60_000) return json(res, 429, { error: 'too many failed attempts' });
        if (fails.size > 5000) { const now = Date.now(); for (const [k, v] of fails) if (now - v.t > 60_000) fails.delete(k); if (fails.size > 5000) fails.clear(); } // bounded memory under spray from many addresses
        if (hasCreds(req)) fails.set(ip, { n: (f && Date.now() - f.t < 60_000 ? f.n : 0) + 1, t: Date.now() });
        return json(res, 401, { error: 'unauthorized' });
      }
      if (f) fails.delete(ip);
      // CSRF: cookie-authenticated state-changing requests must carry the custom header (cross-site forms can't set it).
      if (m !== 'GET' && token && usedCookie(req) && req.headers['x-ytc'] !== '1') return json(res, 403, { error: 'missing x-ytc header' });

      if (p === '/api/login' && m === 'POST') { // a random session id (30 days, revocable), never the master token itself
        const had = sessionId(req); const viaBearer = !usedCookie(req); if (!token || (had && !viaBearer)) return json(res, 200, { ok: true });
        return json(res, 200, { ok: true }, { 'set-cookie': `ytc_sid=${newSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}` }); }
      if (p === '/api/logout' && m === 'POST') { const sid = sessionId(req); if (sid) store.exec('DELETE FROM kv WHERE k=?', `session:${sid}`); return json(res, 200, { ok: true }, { 'set-cookie': 'ytc_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
      if (p === '/api/status') return json(res, 200, { running, version: VERSION, gates: cfg.gates, captionPreset: cfg.edit.captionPreset,
        videos: store.all('SELECT state, count(*) n FROM videos GROUP BY state'), jobs: store.all('SELECT state, count(*) n FROM jobs GROUP BY state'), jobKinds: store.all('SELECT kind, state, count(*) n FROM jobs GROUP BY kind, state'), reviewPending: store.get<{ n: number }>(`SELECT count(*) n FROM clips WHERE review='pending' AND edited_path IS NOT NULL`)?.n ?? 0, clips: store.all('SELECT state, count(*) n FROM clips GROUP BY state'), uploads: store.all('SELECT state, count(*) n FROM uploads GROUP BY state') });
      { const m = p.match(/^\/api\/videos\/(\d+)\/reanalyze$/); if (m && req.method === 'POST') { const b = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}') as { from?: number; to?: number; length?: string; whole?: boolean; maxClips?: number }; if (b.maxClips !== undefined && !(Number.isInteger(b.maxClips) && b.maxClips >= 1 && b.maxClips <= 12)) return json(res, 400, { error: 'maxClips: 1 se 12' }); if (b.length !== undefined && !isLengthBucket(b.length)) return json(res, 400, { error: 'length: u30, 30-60, 60-90 ya 90-180' }); const override = b.from !== undefined || b.to !== undefined ? { ...(b.from !== undefined ? { introEnd: Number(b.from) } : {}), ...(b.to !== undefined ? { outroStart: Number(b.to) } : {}) } : undefined; const r = await analyzeVideo(store, cfg, Number(m[1]), { force: true, override, length: b.length as LengthBucket | undefined, maxClips: b.maxClips, whole: b.whole === true }); seedJobs(store, cfg); return json(res, 200, r); } }
      if (p === '/api/assets' && req.method === 'GET') { const L = (d: string, re: RegExp) => { try { return readdirSync(join(cfg.dirs.assets, d)).filter((x) => re.test(x)).sort(); } catch { return []; } }; return json(res, 200, { music: L('music', /\.(mp3|m4a|wav|ogg)$/i), sfx: L('sfx', /\.(mp3|m4a|wav|ogg)$/i), gameplay: L('gameplay', /\.(mp4|mov|mkv|webm)$/i), overlays: L('vfx_overlays', /\.(mp4|mov|webm|png)$/i), fonts: L('fonts', /\.(ttf|otf)$/i), note: 'Apni files in folders mein rakho (assets/music, assets/gameplay …). Sirf apni ya licensed files.' }); }
      if (p === '/api/videos') return json(res, 200, { videos: store.all(`SELECT id, path, state FROM videos ORDER BY id DESC LIMIT 200`).map((v) => ({ ...(v as { id: number; path: string; state: string }), title: basename((v as { path: string }).path) })) });
      { const dm = p.match(/^\/api\/clips\/(\d+)$/); if (dm && req.method === 'DELETE') { const id = Number(dm[1]); const c = store.get<{ id: number; edited_path: string | null; thumbnail_path: string | null; candidate_id: number }>('SELECT id, edited_path, thumbnail_path, candidate_id FROM clips WHERE id=?', id); if (!c) return json(res, 404, { error: 'unknown clip' });
        if (store.get('SELECT 1 FROM uploads WHERE clip_id=? AND remote_id IS NOT NULL', id) && url.searchParams.get('force') !== '1') return json(res, 409, { needsForce: true, error: 'Ye clip platform par upload ho chuka hai. Yahan se sirf local copy (file + thumbnail) hategi; platform wala video wahin rahega, use platform se khud hatao.' });
        store.tx(() => { store.exec('DELETE FROM uploads WHERE clip_id=?', id); store.exec('DELETE FROM clips WHERE id=?', id); store.exec(`UPDATE candidates SET status='rejected' WHERE id=?`, c.candidate_id); });
        for (const f of [c.edited_path, c.thumbnail_path]) if (f) { try { rmSync(f, { force: true }); } catch { /* already gone */ } }
        return json(res, 200, { ok: true }); } }
      if (p === '/api/claims' && m === 'GET') return json(res, 200, claimSummary(store));
      { const cm = p.match(/^\/api\/clips\/(\d+)\/claim$/); if (cm && req.method === 'POST') { const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { kind: ClaimKind; ranges?: unknown; note?: string }; try { const cr = await recordClaim(store, Number(cm[1]), b); if (cr.sourcePaused) void notify(store, cfg, `srcpause:${cr.sourceId}`, `Source #${cr.sourceId} paused after ${cr.sourceClaims} copyright claims.`); return json(res, 200, cr); } catch (e) { const msg = (e as Error).message; return json(res, /^not found/.test(msg) ? 404 : 400, { error: msg }); } } }
      if (p === '/api/doctor' && m === 'GET') return json(res, 200, { report: lastDoctor_(store) });
      if (p === '/api/doctor' && m === 'POST') { const b = JSON.parse((await readBody(req, 512)).toString('utf8') || '{}') as { fix?: boolean }; return json(res, 200, { report: await runDoctor(store, cfg, { fix: b.fix !== false }) }); }
      if (p === '/api/why' && m === 'GET') return json(res, 200, { items: whyReport(store, cfg, { running: running || !!timer, ytdlp: await ytdlpAvailable() }) });
      if (p === '/api/remeta' && m === 'POST') { const b = JSON.parse((await readBody(req, 2048)).toString('utf8') || '{}') as { clipId?: number; all?: boolean; push?: boolean; confirm?: boolean }; if (b.push && b.confirm !== true) return json(res, 400, { error: 'YouTube par push ke liye confirm:true bhejo' }); return json(res, 200, { ok: true, ...(await remetaClips(store, cfg, { clipIds: b.clipId ? [Number(b.clipId)] : undefined, all: b.all === true, push: b.push === true })) }); }
      if (p === '/api/clips') return json(res, 200, { clips: clipRows() });
      const rv = /^\/api\/clips\/(\d+)\/(review|meta|thumbnail|rerender|export)$/.exec(p);
      if (rv && m === 'POST') {
        const id = Number(rv[1]); const b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
        if (rv[2] === 'review') return json(res, 200, { ok: true, review: reviewClip(store, id, b.action as 'approve' | 'reject' | 'reset', typeof b.note === 'string' ? b.note : undefined) });
        if (rv[2] === 'meta') return json(res, 200, { ok: true, metadata: editClipMeta(store, id, { title: b.title as string | undefined, description: b.description as string | undefined, tags: b.tags as string[] | undefined, thumbnailText: b.thumbnailText as string | undefined }) });
        if (rv[2] === 'thumbnail') { const t = await setThumbnailFrame(store, cfg, id, Number(b.at)); return t ? json(res, 200, { ok: true }) : json(res, 422, { error: 'that frame was rejected (blank/flat); pick another time' }); }
        if (rv[2] === 'export') { const x = exportPackage(store, cfg, id); return json(res, 200, { ok: true, url: `/files/export/${x.name}`, files: x.files }); }
        const o: Record<string, unknown> = {}; for (const k of ['captionPreset', 'pace']) if (typeof b[k] === 'string') o[k] = b[k]; if (b.captionPosition === 'top' || b.captionPosition === 'center' || b.captionPosition === 'bottom') o.captionPosition = b.captionPosition; if (['none', 'fade', 'flash', 'zoom'].includes(String(b.transition))) o.transition = b.transition; if (typeof b.trackSensitivity === 'number' && b.trackSensitivity >= 0 && b.trackSensitivity <= 1) o.trackSensitivity = b.trackSensitivity; if (b.reframe === 'auto' || b.reframe === 'crop' || b.reframe === 'fit_blur') o.reframe = b.reframe; if (typeof b.bgColor === 'string' && /^#[0-9a-f]{6}$/i.test(b.bgColor)) o.bgColor = b.bgColor; if (b.speed !== undefined) { const sp = Number(b.speed); if (typeof b.speed === 'object' || ![1, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1].some((x) => Math.abs(x - sp) < 0.0001)) return json(res, 400, { error: 'invalid: speed must be exactly one of 1, 1.05, 1.06, 1.07, 1.08, 1.09, 1.10 (no ranges)' }); o.speed = sp; } if (b.titleBar === 'black' || b.titleBar === 'white' || b.titleBar === 'off') o.titleBar = b.titleBar; if (b.aspect === '1:1' || b.aspect === '16:9' || b.aspect === '9:16') o.aspect = b.aspect;
        if (Array.isArray(b.cutRanges)) { const cr = (b.cutRanges as unknown[]).filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && typeof r[0] === 'number' && typeof r[1] === 'number' && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]).slice(0, 80); if (b.cutRanges.length && !cr.length) return json(res, 400, { error: 'invalid: cutRanges must be [[startSec,endSec],...]' }); if (cr.length) o.cutRanges = cr; } for (const k of ['zoom', 'glow', 'fade', 'jumpCuts', 'speedRamp', 'beats']) if (typeof b[k] === 'boolean') o[k] = b[k];
        if (b.vfx && typeof b.vfx === 'object') { const v: Record<string, boolean> = {}; for (const k of ['lut', 'grain', 'particles', 'lightLeak', 'flash', 'progress']) if (typeof (b.vfx as Record<string, unknown>)[k] === 'boolean') v[k] = (b.vfx as Record<string, boolean>)[k]!; o.vfx = v; }
        if (!store.get('SELECT 1 FROM clips WHERE id=?', id)) return json(res, 400, { error: `Unknown clip ${id}` });
        enqueue(store, 'rerender', `rerender:${id}:${Date.now()}`, o); void runOnce(); return json(res, 202, { ok: true, queued: true });
      }
      if (p === '/api/setup' && m === 'GET') {
        const yt = youtubeStatus(store, cfg); const dl = await ytdlpAvailable(); const free = freeMb(cfg.dataDir);
        const items = [
          { id: 'ffmpeg', ok: await which('ffmpeg') && await which('ffprobe'), label: 'ffmpeg + ffprobe', fix: 'Install ffmpeg (Termux: pkg install ffmpeg, Ubuntu: apt install ffmpeg)', required: true },
          { id: 'disk', ok: free >= cfg.resources.minFreeDiskMb, label: `Free disk ${free} MB`, fix: 'Free some space (clips are large)', required: true },
          { id: 'stt', ok: !!sttCreds(cfg) || !!(await pickLocal(cfg)) || llmChain(cfg).some((x) => /generativelanguage/.test(x.baseUrl)), label: 'Speech-to-text (captions + smart clipping)', fix: 'Settings -> AI: add a free Groq key, or point to a local faster-whisper server', required: false },
          { id: 'llm', ok: llmChain(cfg).length > 0, label: 'AI titles / clip re-ranking', fix: 'Optional. Settings -> AI: Groq/Gemini key, or Ollama on this machine (no key). Without it the local engine writes titles.', required: false },
          { id: 'ytdlp', ok: dl, label: 'yt-dlp (channel watching)', fix: 'pip install yt-dlp (only needed to watch YouTube channels; file uploads work without it)', required: false },
          { id: 'youtube', ok: !!yt.connected, label: 'YouTube account connected', fix: 'Settings -> YouTube client, then Publish -> Connect', required: false },
          { id: 'token', ok: !!token || LOOPBACK.has(host), label: token ? 'Server token set' : 'Server token: zaroori nahi (sirf is device par chal raha hai)', fix: 'Set YT_CLIPS_TOKEN before exposing the server publicly', required: false },
        ];
        return json(res, 200, { items, ready: items.filter((i) => i.required).every((i) => i.ok) });
      }
      if (p === '/api/activity' && m === 'GET') {
        return json(res, 200, { running, log: store.all(`SELECT entity, entity_id, from_state, to_state, note, at FROM state_log ORDER BY id DESC LIMIT 25`),
          jobs: store.all(`SELECT kind, key, state, attempts, last_error FROM jobs WHERE state IN ('RUNNING','PENDING','RETRY') ORDER BY id LIMIT 12`),
          failed: store.all(`SELECT kind, key, last_error FROM jobs WHERE state='DEAD' ORDER BY id DESC LIMIT 5`) });
      }
      if (p === '/api/autopilot') {
        if (m === 'POST') {
          const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as Record<string, unknown>; const patch: Record<string, unknown> = {};
          for (const k of Object.keys(b)) if (!['autoQueue', 'requireReview', 'platforms', 'fairShare'].includes(k)) return json(res, 400, { error: `invalid: ${k} cannot be changed here (publish gates and autoApprove are owner-only: use the CLI "autopilot" command on the server)` });
          if ('autoQueue' in b) { if (typeof b.autoQueue !== 'boolean') return json(res, 400, { error: 'invalid: autoQueue boolean' }); patch.autoQueue = b.autoQueue; }
          if ('requireReview' in b) { if (typeof b.requireReview !== 'boolean') return json(res, 400, { error: 'invalid: requireReview boolean' }); patch.requireReview = b.requireReview; }
          if ('fairShare' in b) { if (typeof b.fairShare !== 'boolean') return json(res, 400, { error: 'invalid: fairShare boolean' }); patch.fairShare = b.fairShare; }
          if ('platforms' in b) { const ok = ALLOWED_PLATFORMS as readonly string[]; if (!Array.isArray(b.platforms) || !b.platforms.length || b.platforms.some((x) => !ok.includes(String(x)))) return json(res, 400, { error: 'invalid: platforms' }); patch.platforms = b.platforms; }
          updateOwnerConfig(cfg, { automation: patch }); Object.assign(cfg.automation, patch); store.logState('autopilot', 0, null, JSON.stringify(patch), 'changed from the web UI');
        }
        return json(res, 200, { automation: cfg.automation, gates: cfg.gates, note: 'Gates + autoApprove can only be changed on the server (CLI: npm run cli -- autopilot ...).' });
      }
      { const rm = /^\/api\/sources\/(\d+)(?:\/remove)?$/.exec(p); if (rm && (m === 'DELETE' || (m === 'POST' && p.endsWith('/remove')))) { // owner removes a source: it stops being watched and disappears from the lists; videos/clips already made are kept
        const id = Number(rm[1]); if (!store.get('SELECT 1 FROM sources WHERE id=?', id)) return json(res, 400, { error: `Unknown source ${id}` });
        store.tx(() => { store.exec(`UPDATE sources SET status='removed' WHERE id=? OR json_extract(COALESCE(meta_json,'{}'),'$.channelSource')=?`, id, id); }); chCache = null;
        let freedMb = 0; if (url.searchParams.get('files') === '1') { // also free the disk: delete OUR copy of the source video(s) (never the owner's original) and stop any work that still needs them; finished clips stay
          const vids = store.all<{ id: number; path: string }>(`SELECT v.id, v.path FROM videos v JOIN sources s ON s.id=v.source_id WHERE s.id=? OR json_extract(COALESCE(s.meta_json,'{}'),'$.channelSource')=?`, id, id);
          for (const v of vids) { const inside = resolve(v.path).startsWith(resolve(cfg.dirs.sources) + sep); if (inside) { try { freedMb += statSync(v.path).size / 1048576; rmSync(v.path, { force: true }); } catch { /* already gone */ } }
            store.exec(`UPDATE jobs SET state='CANCELLED', lease_until=NULL WHERE state IN ('PENDING','RETRY') AND (key=? OR key IN (SELECT 'render:'||id FROM candidates WHERE video_id=? AND status='candidate'))`, `analyze:${v.id}`, v.id);
            store.exec(`UPDATE candidates SET status='parked' WHERE video_id=? AND status='candidate'`, v.id); store.exec(`UPDATE videos SET state='PARKED' WHERE id=? AND state IN ('NEW','ANALYZING','ANALYZED')`, v.id); }
        }
        return json(res, 200, { ok: true, freedMb: Math.round(freedMb) }); } }
      { const rm = /^\/api\/uploads\/(\d+)(?:\/cancel)?$/.exec(p); if (rm && (m === 'DELETE' || (m === 'POST' && p.endsWith('/cancel')))) { // take an upload out of the queue; only while nothing is on the platform yet
        const id = Number(rm[1]); const u = store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', id); if (!u) return json(res, 400, { error: `Unknown upload ${id}` });
        const force = new URL(req.url ?? '/', 'http://x').searchParams.get('force') === '1';
        if (!force && !['READY_FOR_QC', 'QC_PASSED', 'UPLOAD_PENDING', 'FAILED', 'QC_FAILED'].includes(u.state)) return json(res, 400, { error: `Ye upload ab ${u.state} state me hai (platform par pahunch chuka): wahan se platform ke Studio me hatao.`, needsForce: true });
        if (force && ['UPLOADING', 'UPLOAD_VERIFYING'].includes(u.state)) return json(res, 400, { error: `Upload abhi chal raha hai (${u.state}). Khatam hone ka intezaar karo, phir hatao.` });
        // force = only OUR queue row goes away; a video already on the platform stays there (owner removes it in the platform's own studio)
        store.tx(() => { store.exec('DELETE FROM title_tests WHERE upload_id=?', id); store.exec('DELETE FROM uploads WHERE id=?', id); });
        chCache = null; return json(res, 200, { ok: true, kept: force && !['READY_FOR_QC', 'QC_PASSED', 'UPLOAD_PENDING', 'FAILED', 'QC_FAILED'].includes(u.state) ? 'platform par video waise hi rahegi' : undefined }); } }
      if (p === '/api/uploads/clear' && m === 'POST') { // owner: "queue saaf karo" - drop every upload row except in-flight or scheduled-for-later ones; platform copies are untouched
        const rows = store.all<{ id: number }>("SELECT id FROM uploads WHERE state NOT IN ('UPLOADING','UPLOAD_VERIFYING','SCHEDULED_OR_APPROVED')");
        store.tx(() => { for (const r of rows) { store.exec('DELETE FROM title_tests WHERE upload_id=?', r.id); store.exec('DELETE FROM uploads WHERE id=?', r.id); } });
        chCache = null; return json(res, 200, { ok: true, removed: rows.length }); }
      const sp = /^\/api\/sources\/(\d+)\/status$/.exec(p);
      if (sp && m === 'POST') { const b = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}') as { status?: string }; if (b.status !== 'active' && b.status !== 'paused' && b.status !== 'pending') return json(res, 400, { error: 'invalid: status active|paused|pending' }); const r = store.exec(`UPDATE sources SET status=?, meta_json=json_set(COALESCE(meta_json,'{}'),'$.tries',0) WHERE id=? AND kind<>'local'`, b.status, Number(sp[1])); if (!r.changes) return json(res, 400, { error: 'Unknown source' }); return json(res, 200, { ok: true }); }
      if (p === '/api/presets') return json(res, 200, { current: cfg.edit.captionPreset, pace: cfg.edit.pace, presets: PRESETS.map((x) => ({ id: x.presetId, label: x.label, base: x.id, bname: x.name, palette: x.palette.id, pname: x.palette.name, active: x.palette.active, tags: x.tags, mode: x.mode })) });
      const pv = /^\/api\/presets\/([\w-]+)\/preview\.png$/.exec(p);
      if (pv) { if (!getPreset(pv[1]!)) return json(res, 404, { error: 'unknown preset' }); const lang = url.searchParams.get('lang') === 'hi' ? 'hi' : 'en'; const png = await presetPreview(previewDir, pv[1]!, lang); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' }); return void createReadStream(png).pipe(res); }
      const mf = /^\/api\/manifest\/([\w.-]+)$/.exec(p);
      if (mf) { const f2 = join(cfg.dirs.manifests, `${mf[1]}.json`); if (!existsSync(f2)) return json(res, 404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(readFileSync(f2)); }
      const fl = /^\/files\/(edited|thumb|captions|export)\/([^/]+)$/.exec(p); if (fl && (m === 'GET' || m === 'HEAD')) return serveFile(req, res, fl[1]!, fl[2]!);

      if (p === '/api/config' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as Record<string, unknown>; const patch: Record<string, unknown> = {};
        const known = new Set(['trackSensitivity', 'captionPreset', 'captionEmphasis', 'reframe', 'pace', 'bgColor', 'speed', 'titleBar', 'broll', 'deferTitle']); for (const k of Object.keys(b)) if (!known.has(k)) return json(res, 400, { error: `key not allowed: ${k} (gates/publishing can only be changed by editing data/config.json on the server)` });
        if ('captionPreset' in b) { if (b.captionPreset !== 'none' && !getPreset(String(b.captionPreset))) return json(res, 400, { error: 'unknown caption preset' }); patch.captionPreset = b.captionPreset; }
        if ('captionEmphasis' in b) { if (!Array.isArray(b.captionEmphasis) || b.captionEmphasis.some((x) => typeof x !== 'string' || x.length > 40) || b.captionEmphasis.length > 50) return json(res, 400, { error: 'captionEmphasis must be <=50 short strings' }); patch.captionEmphasis = b.captionEmphasis; }
        if ('reframe' in b) { if (b.reframe !== 'crop' && b.reframe !== 'fit_blur' && b.reframe !== 'auto') return json(res, 400, { error: 'reframe must be auto|crop|fit_blur' }); patch.reframe = b.reframe; }
        for (const k of ['broll', 'deferTitle']) if (k in b) { if (typeof b[k] !== 'boolean') return json(res, 400, { error: `${k} must be true or false` }); patch[k] = b[k]; }
        if ('trackSensitivity' in b) { if (typeof b.trackSensitivity !== 'number' || !(b.trackSensitivity >= 0 && b.trackSensitivity <= 1)) return json(res, 400, { error: 'trackSensitivity must be 0..1' }); patch.trackSensitivity = b.trackSensitivity; }
        if ('bgColor' in b) { if (b.bgColor !== '' && !(typeof b.bgColor === 'string' && /^#[0-9a-f]{6}$/i.test(b.bgColor))) return json(res, 400, { error: 'bgColor must be #rrggbb or empty' }); patch.bgColor = b.bgColor === '' ? undefined : b.bgColor; }
        if ('speed' in b) { const sp = Number(b.speed); if (typeof b.speed === 'object' || ![1, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1].some((x) => Math.abs(x - sp) < 0.0001)) return json(res, 400, { error: 'speed must be exactly one of 1, 1.05, 1.06, 1.07, 1.08, 1.09, 1.10' }); patch.speed = sp; }
        if ('titleBar' in b) { if (!['black', 'white', 'off'].includes(String(b.titleBar))) return json(res, 400, { error: 'titleBar must be black|white|off' }); patch.titleBar = b.titleBar; }
        if ('pace' in b) { if (!isPace(b.pace)) return json(res, 400, { error: 'pace must be fast|medium|relaxed|off' }); patch.pace = b.pace; }
        updateOwnerConfig(cfg, { edit: patch }); Object.assign(cfg.edit, patch); return json(res, 200, { ok: true, edit: { captionPreset: cfg.edit.captionPreset, captionEmphasis: cfg.edit.captionEmphasis, reframe: cfg.edit.reframe, pace: cfg.edit.pace } });
      }
      if (p === '/api/storage' && m === 'GET') return json(res, 200, { ...storageStatus(store, cfg), rclone: await rcloneAvailable(), remotes: await listRemotes() });
      if (p === '/api/storage' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}') as Record<string, unknown>; const patch: Record<string, unknown> = {};
        if (b.remote !== undefined) { const r = String(b.remote).trim(); if (r && !validRemote(r)) return json(res, 400, { error: 'invalid: remote (format name:folder, e.g. gdrive:yt-clips)' }); patch.remote = r; }
        if (b.deleteLocal !== undefined) patch.deleteLocal = !!b.deleteLocal;
        if (b.purgeAfterDays !== undefined) { const n = Number(b.purgeAfterDays); if (!Number.isInteger(n) || n < 0 || n > 3650) return json(res, 400, { error: 'invalid: purgeAfterDays 0-3650' }); patch.purgeAfterDays = n; }
        updateOwnerConfig(cfg, { storage: patch }); Object.assign(cfg.storage, patch); return json(res, 200, storageStatus(store, cfg));
      }
      if (p === '/api/storage/test' && m === 'POST') return json(res, 200, await testRemote(cfg));
      if (p === '/api/storage/run' && m === 'POST') return json(res, 200, await storageTick(store, cfg));
      if (p === '/api/youtube/settings' && m === 'GET') return json(res, 200, cfg.youtube);
      if (p === '/api/youtube/settings' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 512)).toString('utf8') || '{}') as Record<string, unknown>; const lim: Record<string, [number, number]> = { pollMinutes: [5, 720], maxDurationMin: [10, 1440], maxPerPoll: [1, 10], maxHeight: [360, 1080] }; const patch: Record<string, number> = {};
        for (const [k, [lo, hi]] of Object.entries(lim)) if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isInteger(n) || n < lo || n > hi) return json(res, 400, { error: `invalid: ${k} must be ${lo}-${hi}` }); patch[k] = n; }
        updateOwnerConfig(cfg, { youtube: patch }); Object.assign(cfg.youtube, patch); return json(res, 200, cfg.youtube);
      }
      if (p === '/api/sources/poll' && m === 'POST') { if (!(await ytdlpAvailable())) return json(res, 200, { error: 'yt-dlp install nahi hai: pkg install python && pip install -U yt-dlp' }); return json(res, 200, await pollSources(store, cfg)); }
      if (p === '/api/sources' && m === 'GET') return json(res, 200, { poll: (() => { try { return JSON.parse(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='poll:last'`)?.v ?? 'null'); } catch { return null; } })(), ytdlp: await ytdlpAvailable(), sources: store.all(`SELECT s.id, s.kind, s.uri, s.title, s.status, s.authorized, s.channel_id, s.meta_json, ch.slug AS channel FROM sources s LEFT JOIN channels ch ON ch.id=s.channel_id WHERE s.status<>'removed' ORDER BY s.id DESC LIMIT 200`) });
      if (p === '/api/sources' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}') as { url?: string; authorized?: boolean; channel?: string; audioLang?: string; range?: string };
        const audioLang = String(b.audioLang ?? '').trim().toLowerCase(); if (audioLang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(audioLang)) return json(res, 400, { error: 'audioLang: use a language code like hi or en' });
        let range: { start: number; end: number } | null = null; try { range = parseRange(b.range); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
        const r = addYoutubeSource(store, String(b.url ?? ''), b.authorized === true, b.channel ? getChannel(store, String(b.channel)).id : undefined, { ...(audioLang ? { audioLang } : {}), range }); lastPoll = 0; void runOnce(); return json(res, 200, { ok: true, ...r, ytdlp: await ytdlpAvailable() });
      }
      if (p === '/api/stream' && m === 'GET') {
        // Server-Sent Events: pushes only NEW log lines + queue state (no 6 s polling). UI falls back to polling if EventSource fails.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        // DELTA stream: first message carries the last 60 lines (full:true); afterwards only lines newer than the last one sent. Idle ticks send nothing.
        let last = ''; let seen = 0; let lastSeq = -1;
        const tick = () => {
          const first = lastSeq < 0; const logs = first ? recentLogs(60, 'info') : logsSince(lastSeq).filter((l) => l.level !== 'debug');
          if (logs.length) lastSeq = (logs[logs.length - 1] as { seq: number }).seq; else if (first) lastSeq = 0;
          const snap = { now: new Date().toISOString(), full: first, paused: queuePaused(store), running: store.all(`SELECT kind, key, attempts FROM jobs WHERE state='RUNNING' ORDER BY id LIMIT 10`), pending: store.get<{ n: number }>(`SELECT count(*) n FROM jobs WHERE state IN ('PENDING','RETRY')`)?.n ?? 0, logs };
          const sig = JSON.stringify([snap.paused, snap.running, snap.pending]) + logs.length;
          if (first || logs.length || sig !== last) { last = sig; res.write(`data: ${JSON.stringify(snap)}\n\n`); seen = 0; } else if (++seen % 10 === 0) res.write(`event: hb\ndata: ${Date.now()}\n\n`);
        };
        tick(); const t = setInterval(tick, 1000); req.on('close', () => clearInterval(t)); return;
      }
      if (p === '/api/ai/health' && m === 'GET') { const { llmHealth } = await import('./../ai/health.ts'); const { llmChain } = await import('./../ai/settings.ts'); return json(res, 200, { llm: llmHealth(llmChain(cfg)) }); }
      if (p === '/api/logs' && m === 'GET') return json(res, 200, { now: new Date().toISOString(), paused: queuePaused(store), running: store.all(`SELECT kind, key, attempts FROM jobs WHERE state='RUNNING' ORDER BY id LIMIT 10`), pending: store.get<{ n: number }>(`SELECT count(*) n FROM jobs WHERE state IN ('PENDING','RETRY')`)?.n ?? 0, logs: recentLogs(Math.min(200, Number(url.searchParams.get('n') ?? 60)), url.searchParams.get('level') === 'warn' ? 'warn' : 'info') });
      if (p === '/api/uploads' && m === 'GET') return json(res, 200, { uploads: listUploads(store) });
      if (p === '/api/uploads' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { clipId?: number; platform?: string };
        if (!Number.isInteger(b.clipId) || !b.platform) return json(res, 400, { error: 'invalid: clipId (int) and platform required' });
        return json(res, 200, { ok: true, id: queueUpload(store, b.clipId!, String(b.platform)) });
      }
      const adv = /^\/api\/uploads\/(\d+)\/advance$/.exec(p);
      if (adv && m === 'POST') {
        const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { approve?: boolean; scheduledAt?: string };
        const at = b.scheduledAt ? new Date(b.scheduledAt) : null; if (at && Number.isNaN(at.getTime())) return json(res, 400, { error: 'invalid scheduledAt' });
        const r = await advance(store, cfg, Number(adv[1]), { approve: b.approve === true, scheduledAt: at }); return json(res, 200, r);
      }
      if (p === '/api/youtube' && m === 'GET') return json(res, 200, youtubeStatus(store, cfg));
      if (p === '/api/youtube/connect' && m === 'POST') { const d = await youtubeConnectStart(store, cfg); return json(res, 200, { userCode: d.user_code, verificationUrl: d.verification_url, expiresIn: d.expires_in, interval: d.interval }); }
      if (p === '/api/youtube/connect/poll' && m === 'POST') return json(res, 200, await youtubeConnectPoll(store, cfg));
      if (p === '/api/comments' && m === 'GET') return json(res, 200, { comments: store.all(`SELECT id, platform, remote_id, text, class, draft, status, created_at FROM comments ORDER BY id DESC LIMIT 200`) });
      if (p === '/api/comments/collect' && m === 'POST') return json(res, 200, await collectYoutubeComments(store, cfg));
      const cm = /^\/api\/comments\/(\d+)\/(approve|reject|edit|post)$/.exec(p);
      if (cm && m === 'POST') {
        const id = Number(cm[1]); const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { text?: string };
        if (cm[2] === 'post') { try { await postComment(store, cfg, id); } catch (e) { const msg = (e as Error).message; if (/^(COMMENTS_DISABLED|AUTH_|QUOTA_EXCEEDED)/.test(msg) || /not approved|No draft/.test(msg)) return json(res, 409, { error: msg.slice(0, 300) }); throw e; } return json(res, 200, { ok: true }); }
        setCommentStatus(store, id, cm[2] as 'approve' | 'reject' | 'edit', b.text); return json(res, 200, { ok: true });
      }
      if (p === '/api/settings' && m === 'GET') return json(res, 200, { ai: aiStatus(cfg), apps: { facebook: !!appCreds(cfg, 'facebook'), tiktok: !!appCreds(cfg, 'tiktok') }, platforms: platformStatus(store, cfg), callbackBase: publicBase(req) });
      if (p === '/api/settings/ai' && m === 'POST') { const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { kind?: string; apiKey?: string; baseUrl?: string; model?: string; slot?: number }; if (b.kind !== 'stt' && b.kind !== 'llm') return json(res, 400, { error: 'invalid: kind must be stt or llm' }); saveAi(cfg, b.kind, b); const test = await testConnection(store, cfg, b.kind === 'stt' ? 'stt' : `llm:${b.slot ?? 1}`); return json(res, 200, { ok: true, ai: aiStatus(cfg), test }); }
      if (p === '/api/settings/oauth-app' && m === 'POST') { const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { app?: string; clientId?: string; clientSecret?: string }; saveAppCreds(cfg, String(b.app), String(b.clientId ?? ''), String(b.clientSecret ?? '')); const test = b.app === 'google' ? await testConnection(store, cfg, 'google-client') : null; return json(res, 200, { ok: true, test }); }
      const os = /^\/api\/oauth\/(facebook|tiktok)\/start$/.exec(p); if (os && m === 'GET') return json(res, 200, { authUrl: startAuth(store, cfg, os[1] as SocialApp, publicBase(req), { publish: url.searchParams.get('publish') === '1' }), redirectUri: `${publicBase(req)}/api/oauth/${os[1]}/callback` });
      if (p === '/api/platforms' && m === 'GET') return json(res, 200, { platforms: platformStatus(store, cfg), registry: PLATFORMS.map((x) => ({ id: x.id, label: x.label, kind: x.kind, note: x.note, fields: x.fields?.map((f) => ({ name: f.name, label: f.label, secret: !!f.secret })), configured: x.kind === 'direct' ? credentialsConfigured(secretsFor(cfg), x.id) : x.kind === 'oauth' ? metaCanPublish(secretsFor(cfg), x.id) : x.kind === 'manual', app: x.app ?? null, openUrl: x.openUrl ?? null, loggedIn: x.kind === 'oauth' ? (metaPerms(secretsFor(cfg), x.id === 'facebook_reels' ? 'facebook' : 'instagram').length > 0 || !!secretsFor(cfg).read(x.id === 'facebook_reels' ? 'facebook' : 'instagram')) : false, appSaved: x.app ? !!appCreds(cfg, x.app) : null })) });
      const cred = /^\/api\/credentials\/(\w+)$/.exec(p);
      if (cred && m === 'POST') { // write-only vault: values are validated, stored (encrypted when a key exists) and never returned or logged
        const b = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8') || '{}') as { fields?: Record<string, unknown>; channel?: string };
        const ch = b.channel ? getChannel(store, b.channel) : null; if (!platformInfo(cred[1]!) && cred[1] !== 'notify') return json(res, 400, { error: 'invalid: unknown platform' });
        saveCredentials(secretsFor(cfg), cred[1]!, b.fields ?? {}, ch && ch.slug !== 'main' ? `${platformInfo(cred[1]!)?.secret ?? 'notify'}-${ch.slug}` : undefined); store.logState('credentials', 0, null, 'saved', `${cred[1]}${ch ? ':' + ch.slug : ''}`);
        const slug = ch && ch.slug !== 'main' ? ch.slug : undefined; const test = await testConnection(store, cfg, slug ? `${cred[1]}:${slug}` : cred[1]!);
        return json(res, 200, { ok: true, encrypted: secretsFor(cfg).encrypted, test });
      }
      if (p === '/api/manual' && m === 'GET') {
        const rows = store.all<{ id: number; platform: string; scheduled_at: string | null; output_id: string; metadata_json: string | null; slug: string | null }>(`SELECT u.id, u.platform, u.scheduled_at, c.output_id, c.metadata_json, ch.slug FROM uploads u JOIN clips c ON c.id=u.clip_id LEFT JOIN channels ch ON ch.id=u.channel_id WHERE u.state='SCHEDULED_OR_APPROVED' AND u.platform IN (${PLATFORMS.filter((x) => x.kind === 'manual' || x.kind === 'oauth').map((x) => `'${x.id}'`).join(',')}) ORDER BY u.scheduled_at LIMIT 100`);
        return json(res, 200, { tasks: rows.filter((r) => !metaCanPublish(secretsFor(cfg), r.platform)).map((r) => { const md = r.metadata_json ? JSON.parse(r.metadata_json) as { title?: string; description?: string; tags?: string[] } : {}; const due = !r.scheduled_at || Date.parse(r.scheduled_at.replace(' ', 'T') + (/Z|\+/.test(r.scheduled_at) ? '' : 'Z')) <= Date.now(); return { uploadId: r.id, platform: r.platform, channel: r.slug ?? 'main', due, at: r.scheduled_at, title: md.title ?? '', caption: md.description ?? '', tags: md.tags ?? [], video: `/files/edited/${r.output_id}.mp4` }; }) });
      }
      const posted = /^\/api\/uploads\/(\d+)\/posted$/.exec(p);
      if (posted && m === 'POST') { const b = JSON.parse((await readBody(req, 2048)).toString('utf8') || '{}') as { url?: string }; markPosted(store, Number(posted[1]), b.url ? String(b.url) : undefined); return json(res, 200, { ok: true }); }
      const tk = /^\/api\/platforms\/(\w+)\/token$/.exec(p);
      if (tk && m === 'POST') { const b = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}') as { accessToken?: string }; saveTokenFor(cfg, tk[1]!, String(b.accessToken ?? '')); return json(res, 200, { ok: true }); }
      if (p === '/api/titletests' && m === 'GET') return json(res, 200, { tests: listTitleTests(store), enabled: cfg.automation.titleTest });
      if (p === '/api/retention/collect' && m === 'POST') return json(res, 200, await collectRetention(store, cfg));
      if (p === '/api/learnings' && m === 'GET') return json(res, 200, { channels: listChannels(store).map((ch) => ({ slug: ch.slug, categoryPrior: learnedCategoryPrior(store, ch.id), retentionRows: store.get<{ n: number }>('SELECT count(*) n FROM retention WHERE channel_id=?', ch.id)!.n })) });
      if (p === '/api/analytics/collect' && m === 'POST') return json(res, 200, { results: await collectAnalytics(store, analyticsProviders(store, cfg)) });
      if (p === '/api/analytics' && m === 'GET') return json(res, 200, { platforms: analyticsSummary(store, cfg.timezone, (pl) => hourStats(store, cfg.timezone, pl)) });
      if (p === '/api/analytics/import' && m === 'POST') return json(res, 200, importAnalyticsCsv(store, (await readBody(req, 5 * 1024 * 1024)).toString('utf8'), url.searchParams.get('platform') ?? undefined));
      if (await handleStudio({ req, res, p, m, url, store, cfg, deps: o.studioDeps ?? {}, json, readBody, sendPath })) return;
      if (p === '/api/channels' && m === 'GET') {
        if (chCache && Date.now() - chCache.t < 15_000) return json(res, 200, chCache.body); // planning slots per channel is CPU heavy (≈20 ms each): with hundreds of channels + a busy dashboard it starved the server, so the answer is shared for 15 s and any write clears it
        const from = new Date(); if (!chPending) chPending = (async () => { const out = []; for (const ch of listChannels(store)) { out.push((() => {
          const eff = scheduleFor(cfg, ch); const pl = planFromStore(store, { n: 3, tz: cfg.timezone, cfg: eff, from, channelId: ch.id });
          const cnt = store.get<{ sources: number }>('SELECT count(*) AS sources FROM sources WHERE channel_id=?', ch.id)!;
          const up = store.get<{ queued: number; scheduled: number; published: number }>(`SELECT count(*) AS queued, sum(state='SCHEDULED_OR_APPROVED') AS scheduled, sum(state='PUBLISHED') AS published FROM uploads WHERE channel_id=?`, ch.id)!;
          const yt = youtubeStatus(store, cfg, ch);
          return { id: ch.id, slug: ch.slug, name: ch.name, profile: ch.profile, config: ch.config, schedule: eff, evidenceRows: pl.samples, nextSlots: pl.slots.map((x) => ({ at: x.at.toISOString(), hour: x.hour, basis: x.basis })), sources: cnt.sources, uploads: { queued: up.queued, scheduled: up.scheduled ?? 0, published: up.published ?? 0 }, youtube: { connected: yt.connected, clientConfigured: yt.clientConfigured, identity: identityOf(store, ch.slug) } };
        })()); await new Promise((r) => setImmediate(r)); } return out; })().finally(() => { chPending = null; }); // one computation shared by concurrent callers; yields between channels so other requests keep flowing
        const rows = await chPending;
        const body = { channels: rows, platforms: ALLOWED_PLATFORMS, timezone: cfg.timezone, globalSchedule: cfg.schedule }; chCache = { t: Date.now(), body };
        return json(res, 200, body);
      }
      if (p === '/api/channels' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}') as { name?: string; profile?: string; config?: unknown };
        return json(res, 200, { ok: true, channel: createChannel(store, { name: String(b.name ?? ''), profile: b.profile, config: b.config }, (id) => !!getPreset(id)) });
      }
      const chm = /^\/api\/channels\/([\w-]{1,40})(?:\/(youtube\/connect\/poll|youtube\/connect|youtube\/web|youtube\/paste|youtube|plan|optimize|videos))?$/.exec(p);
      if (chm) {
        const ch = getChannel(store, chm[1]!);
        if (!chm[2] && m === 'POST') { const b = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}') as { name?: string; profile?: string; config?: unknown; archived?: boolean }; return json(res, 200, { ok: true, channel: updateChannel(store, ch.id, b, (id) => !!getPreset(id)) }); }
        if (chm[2] === 'plan' && m === 'GET') { const pl = planFromStore(store, { n: Math.min(30, Math.max(1, Number(url.searchParams.get('n') ?? 7))), tz: cfg.timezone, cfg: scheduleFor(cfg, ch), channelId: ch.id, platform: url.searchParams.get('platform') ?? undefined }); return json(res, 200, { samples: pl.samples, slots: pl.slots.map((x) => ({ at: x.at.toISOString(), hour: x.hour, basis: x.basis })) }); }
        if (chm[2] === 'youtube/web' && m === 'POST') { const b = JSON.parse((await readBody(req, 512)).toString('utf8') || '{}') as { share?: boolean; paste?: boolean }; const w = startWebAuth(store, cfg, ch, { base: publicBase(req), share: b.share === true, paste: b.paste === true }); return json(res, 200, w); }
        if (chm[2] === 'youtube/paste' && m === 'POST') { const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { url?: string }; try { const r = await finishPaste(store, cfg, ch.slug, String(b.url ?? '')); return json(res, 200, { ok: true, identity: r.identity }); } catch (e) { return json(res, 400, { error: String((e as Error).message).slice(0, 240) }); } }
        if (chm[2] === 'videos' && m === 'GET') { try { return json(res, 200, await channelVideos(store, cfg, ch)); } catch (e) { return json(res, 400, { error: (e as Error).message }); } }
        if (chm[2] === 'optimize' && m === 'GET') return json(res, 200, storedAccountKit(store, ch.slug) ?? { kit: null });
        if (chm[2] === 'optimize' && m === 'POST') { const b = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}') as { apply?: boolean; playlists?: boolean; confirm?: boolean }; if (b.apply && b.confirm !== true) return json(res, 400, { error: 'apply ke liye confirm:true bhejo' }); try { return json(res, 200, { ok: true, ...(await optimizeAccount(store, cfg, ch, { apply: b.apply === true, playlists: b.playlists === true })) }); } catch (e) { return json(res, 400, { error: (e as Error).message }); } }
        if (chm[2] === 'youtube' && m === 'GET') return json(res, 200, { ...youtubeStatus(store, cfg, ch), identity: identityOf(store, ch.slug) });
        if (chm[2] === 'youtube/connect' && m === 'POST') { const d = await youtubeConnectStart(store, cfg, ch); return json(res, 200, { userCode: d.user_code, verificationUrl: d.verification_url, expiresIn: d.expires_in, interval: d.interval }); }
        if (chm[2] === 'youtube/connect/poll' && m === 'POST') return json(res, 200, await youtubeConnectPoll(store, cfg, ch));
      }
      const srcLive = /^\/api\/sources\/(\d+)\/live$/.exec(p);
      if (srcLive && m === 'POST') { // opt-in live-stream auto-capture for a watched channel
        const b = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}') as { watch?: boolean };
        const row = store.get<{ kind: string; meta_json: string | null }>('SELECT kind, meta_json FROM sources WHERE id=?', Number(srcLive[1])); if (!row) return json(res, 404, { error: 'unknown source' });
        if (row.kind !== 'youtube_channel') return json(res, 400, { error: 'Live capture sirf YouTube channel source par chalta hai (video/upload par nahi)' });
        let mj: Record<string, unknown> = {}; try { mj = JSON.parse(row.meta_json || '{}'); } catch { /* ignore */ }
        mj.watchLive = b.watch === true; store.exec('UPDATE sources SET meta_json=? WHERE id=?', JSON.stringify(mj), Number(srcLive[1])); return json(res, 200, { ok: true, watchLive: mj.watchLive });
      }
      const srcCh = /^\/api\/sources\/(\d+)\/channel$/.exec(p);
      if (srcCh && m === 'POST') {
        const b = JSON.parse((await readBody(req, 2048)).toString('utf8') || '{}') as { channel?: string }; const ch = getChannel(store, String(b.channel ?? ''));
        const r = store.exec('UPDATE sources SET channel_id=? WHERE id=?', ch.id, Number(srcCh[1])); if (!r.changes) return json(res, 404, { error: 'unknown source' });
        const kids = store.exec(`UPDATE sources SET channel_id=? WHERE json_extract(meta_json,'$.channelSource')=?`, ch.id, Number(srcCh[1])).changes; // videos found by a watched channel follow its mapping
        const ups = store.exec(`UPDATE uploads SET channel_id=? WHERE remote_id IS NULL AND clip_id IN (SELECT c.id FROM clips c JOIN candidates cd ON cd.id=c.candidate_id JOIN videos v ON v.id=cd.video_id JOIN sources s ON s.id=v.source_id WHERE s.id=? OR json_extract(s.meta_json,'$.channelSource')=?)`, ch.id, Number(srcCh[1]), Number(srcCh[1])).changes;
        return json(res, 200, { ok: true, channel: ch.slug, videosMoved: kids, uploadsMoved: ups }); // finished uploads keep their channel; unsent ones follow
      }
      if (p === '/api/calendar' && m === 'GET') {
        const rows = store.all<{ id: number; platform: string; state: string; scheduled_at: string; slug: string | null; name: string | null; output_id: string; metadata_json: string | null }>(`SELECT u.id, u.platform, u.state, u.scheduled_at, ch.slug, ch.name, c.output_id, c.metadata_json FROM uploads u JOIN clips c ON c.id=u.clip_id LEFT JOIN channels ch ON ch.id=u.channel_id WHERE u.scheduled_at IS NOT NULL AND u.state IN ('SCHEDULED_OR_APPROVED','PUBLISHED') AND u.scheduled_at >= datetime('now','-1 day') ORDER BY u.scheduled_at LIMIT 300`);
        return json(res, 200, { timezone: cfg.timezone, items: rows.map((r) => { let title = ''; try { title = (JSON.parse(String((r as { metadata_json?: string }).metadata_json ?? '{}')) as { title?: string }).title ?? ''; } catch { /* none */ } const { metadata_json: _m, ...rest } = r as typeof r & { metadata_json?: string }; return { ...rest, title }; }) });
      }
      if (p === '/api/schedule' && m === 'GET') { const sch = url.searchParams.get('channel') ? getChannel(store, url.searchParams.get('channel')) : null; const pl = planFromStore(store, { n: Math.min(30, Math.max(1, Number(url.searchParams.get('n') ?? 3))), tz: cfg.timezone, cfg: sch ? scheduleFor(cfg, sch) : cfg.schedule, channelId: sch?.id }); return json(res, 200, { samples: pl.samples, slots: pl.slots.map((x) => ({ at: x.at.toISOString(), hour: x.hour, basis: x.basis })) }); }
      if (p === '/api/ai/models' && m === 'POST') { const b = JSON.parse((await readBody(req, 512)).toString('utf8') || '{}') as { slot?: number }; return json(res, 200, await listModels(cfg, Number(b.slot ?? 1))); }
      if (p === '/api/ai/env' && m === 'GET') return json(res, 200, { file: dotEnvInfo.file ? '.env' : null, detected: envStatus().filter((x) => x.var) });
      if (p === '/api/ai/env' && m === 'POST') return json(res, 200, { results: await runEnvApply(true) });
      if (p === '/api/ai/providers' && m === 'GET') { const conn = lastResults(store); return json(res, 200, { providers: CATALOG.map((c) => { const n = SLOT_LIST.find((i) => llmSlot(cfg, i)?.baseUrl === c.base); const sl = n ? llmSlot(cfg, n) : null; const r = n ? conn[`llm:${n}`] : undefined; return { id: c.id, label: c.label, keyHint: c.keyHint, getKey: c.getKey, keyless: !c.keyHint, saved: !!sl, model: sl?.model ?? null, slot: n ?? null, status: !sl ? 'none' : r ? (r.ok ? 'ok' : 'error') : 'unknown', detail: r?.detail ?? '' }; }), stt: sttCreds(cfg) ? { base: sttCreds(cfg)!.baseUrl, model: sttCreds(cfg)!.model, result: conn.stt ?? null } : null }); }
      if (p === '/api/ai/provider' && m === 'POST') { const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { id?: string; apiKey?: string }; const c = CATALOG.find((x) => x.id === b.id); if (!c) return json(res, 400, { error: 'invalid: provider' }); const key = String(b.apiKey ?? '').trim(); if (!key && c.keyHint) return json(res, 400, { error: 'invalid: API key daalo' }); const rep = await saveProviderKey(cfg, c.id, key); let test = null; if (rep.llm) test = await testConnection(store, cfg, `llm:${rep.llm.slot}`); return json(res, 200, { ...rep, test }); }
      if (p === '/api/ai/fix' && m === 'POST') { const b = JSON.parse((await readBody(req, 512)).toString('utf8') || '{}') as { target?: string }; const tg = String(b.target ?? ''); if (!/^(llm:[1-6]|stt)$/.test(tg)) return json(res, 400, { error: 'invalid: target' }); const rep = await autoFix(cfg, tg); const test = await testConnection(store, cfg, tg); return json(res, 200, { ...rep, test }); }
      if (p === '/api/ai/auto' && m === 'POST') { const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { apiKey?: string; provider?: string; baseUrl?: string; slot?: number }; if (b.baseUrl && !/^https?:\/\/[^\s]+$/.test(b.baseUrl)) return json(res, 400, { error: 'invalid: baseUrl' }); const rep = await autoSetup(cfg, b); if (rep.llm) rep.steps.push({ ok: (await testConnection(store, cfg, `llm:${rep.llm.slot}`)).ok, text: 'Save ke baad dobara asli test' }); return json(res, 200, rep); }
      if (p === '/api/local/report' && m === 'GET') return json(res, 200, await localReport(cfg));
      if (p === '/api/stt/local' && m === 'GET') { const engines = await detectLocalEngines(cfg); return json(res, 200, { engines, engine: cfg.stt.engine, localEngine: cfg.stt.localEngine ?? 'auto', model: cfg.stt.model, language: cfg.stt.language, cppModel: cppModelPath(cfg), dictionary: cfg.stt.dictionary ?? [], voiceStudioUrl: voiceStudioUrl(cfg), apiSaved: !!sttCreds(cfg) }); }
      if (p === '/api/stt/local' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 2048)).toString('utf8') || '{}') as Record<string, unknown>; const patch: Record<string, unknown> = {};
        if (b.engine !== undefined) { if (!['auto', 'local', 'api'].includes(String(b.engine))) return json(res, 400, { error: 'invalid: engine' }); patch.engine = b.engine; }
        if (b.localEngine !== undefined) { if (!['auto', 'faster-whisper', 'whisper-cpp', 'whisper-cli', 'custom', 'voicestudio'].includes(String(b.localEngine))) return json(res, 400, { error: 'invalid: localEngine' }); patch.localEngine = b.localEngine; }
        if (b.model !== undefined) { if (!/^[\w.\-]{1,40}$/.test(String(b.model))) return json(res, 400, { error: 'invalid: model' }); patch.model = b.model; }
        if (b.language !== undefined) { if (!/^(auto|[a-z]{2,3})$/.test(String(b.language))) return json(res, 400, { error: 'invalid: language' }); patch.language = b.language; }
        if (b.cppModel !== undefined) { const v = String(b.cppModel).trim(); if (v && (!/^[^\0\n]{1,300}$/.test(v) || !existsSync(v))) return json(res, 400, { error: 'invalid: cppModel file nahi mili' }); patch.cppModel = v; }
        if (b.voiceStudioUrl !== undefined) { const v = String(b.voiceStudioUrl).trim().replace(/\/+$/, ''); if (v && !/^https?:\/\/[^\s]+$/.test(v)) return json(res, 400, { error: 'invalid: voiceStudioUrl' }); patch.voiceStudioUrl = v; }
        if (b.dictionary !== undefined) { const arr = (Array.isArray(b.dictionary) ? b.dictionary : String(b.dictionary).split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean); if (arr.length > 60 || arr.some((x) => x.length > 40 || /[\0<>{}]/.test(x))) return json(res, 400, { error: 'invalid: dictionary (max 60 words, 40 chars each)' }); patch.dictionary = [...new Set(arr)]; }
        updateOwnerConfig(cfg, { stt: patch }); Object.assign(cfg.stt, patch); return json(res, 200, { ok: true });
      }
      if (p === '/api/stt/local/test' && m === 'POST') { const b = JSON.parse((await readBody(req, 512)).toString('utf8') || '{}') as { engine?: string }; return json(res, 200, await testLocal(cfg, String(b.engine) as LocalEngineId)); }
      if (p === '/api/connections' && m === 'GET') return json(res, 200, { results: lastResults(store), targets: knownTargets(store, cfg) });
      if (p === '/api/connections/test' && m === 'POST') { const b = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}') as { target?: string }; try { return json(res, 200, await testConnection(store, cfg, String(b.target ?? ''))); } catch (e) { return json(res, 400, { error: (e as Error).message }); } }
      if (p === '/api/todo' && m === 'GET') {
        const one = (q: string, ...a: (string | number | null)[]) => (store.get<{ n: number }>(q, ...a)?.n ?? 0);
        const review = one(`SELECT count(*) n FROM clips WHERE review='pending' AND qc_pass=1`);
        const blocked = store.all<{ id: number; platform: string; state: string; error: string | null }>(`SELECT id, platform, state, error FROM uploads WHERE error IS NOT NULL AND error<>'' AND state NOT IN ('PUBLISHED') ORDER BY id DESC LIMIT 20`);
        const manualDue = one(`SELECT count(*) n FROM uploads WHERE state='SCHEDULED_OR_APPROVED' AND platform IN (${PLATFORMS.filter((x) => x.kind === 'manual').map((x) => `'${x.id}'`).join(',')}) AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))`);
        const dead = store.all<{ key: string; last_error: string | null }>(`SELECT key, last_error FROM jobs WHERE state='DEAD' ORDER BY id DESC LIMIT 5`);
        const items: { level: 'bad' | 'warn' | 'ok' | 'info'; text: string; go?: string }[] = [];
        if (dead.length) items.push({ level: 'bad', text: `${dead.length} job fail hui: ${dead[0]!.key} — ${(dead[0]!.last_error ?? '').slice(0, 90)}`, go: 'home' });
        if (review) items.push({ level: 'warn', text: `${review} clip aapke review ka wait kar rahi hai`, go: 'clips' });
        if (manualDue) items.push({ level: 'warn', text: `${manualDue} manual post abhi karni hai (Instagram/TikTok etc.)`, go: 'publish' });
        for (const b of blocked.slice(0, 3)) items.push({ level: 'warn', text: `Upload #${b.id} (${b.platform}) ruka hai: ${(b.error ?? '').slice(0, 100)}`, go: 'publish' });
        { const pl = store.get<{ v: string }>(`SELECT v FROM kv WHERE k='poll:last'`); if (pl) { try { const j = JSON.parse(pl.v) as { error?: string; channels?: number; discovered: number }; if (j.error) items.push({ level: 'bad', text: `Channel watching fail: ${j.error}`, go: 'home' }); else if (j.channels && !j.discovered) items.push({ level: 'info', text: 'Channel check hua: koi naya video nahi mila (ya sab pehle se list mein)', go: 'home' }); } catch { /* ignore */ } } }
        const conn = lastResults(store); for (const [k, v] of Object.entries(conn)) if (!v.ok) items.push({ level: 'bad', text: `${k} connect nahi: ${v.detail.slice(0, 260)}`, go: 'settings', ...(/^(llm:[1-6]|stt)$/.test(k) ? { fix: k } : {}) });
        if (!llmChain(cfg).length) items.push({ level: 'info', text: 'AI key nahi hai: titles/ranking local engine se hongi (Setup mein free key daalo)', go: 'settings' });
        if (!sttCreds(cfg)) items.push({ level: 'info', text: 'Speech-to-text nahi hai: captions generic honge (Setup → AI → speech-to-text)', go: 'settings' });
        if (!cfg.automation.autoQueue) items.push({ level: 'info', text: 'Autopilot OFF: clips ban jaayengi par upload khud queue nahi hoga', go: 'settings' });
        if (!items.length) items.push({ level: 'ok', text: 'Sab theek hai — koi kaam baaki nahi' });
        return json(res, 200, { items, counts: { review, manualDue, blocked: blocked.length, dead: dead.length } });
      }
      if (p === '/api/run' && m === 'POST') { void runOnce(); return json(res, 202, { started: true }); }
      if (p === '/api/upload' && m === 'POST') {
        if (url.searchParams.get('authorized') !== '1') return json(res, 400, { error: 'rights/authorization must be confirmed (authorized=1)' });
        checkDisk(cfg.dataDir, cfg.resources.minFreeDiskMb);
        const len = Number(req.headers['content-length'] ?? 0); if (len > maxUpload) return json(res, 413, { error: `file larger than ${Math.round(maxUpload / 1048576)}MB limit` });
        const tmp = join(uploadDir, `${randomUUID()}_${safeName(url.searchParams.get('name') ?? 'upload.mp4')}`); let n = 0;
        try {
          req.on('data', (c: Buffer) => { n += c.length; if (n > maxUpload) req.destroy(new Error('too large')); });
          await pipeline(req, createWriteStream(tmp));
          const r = await ingestLocal(store, cfg, tmp, { authorized: true, title: safeName(url.searchParams.get('name') ?? ''), channelId: url.searchParams.get('channel') ? getChannel(store, url.searchParams.get('channel')).id : undefined });
          void runOnce(); return json(res, 200, { ok: true, videoId: r.videoId, duplicate: r.duplicate });
        } finally { rmSync(tmp, { force: true }); }
      }
      if (p === '/api/transcript' && m === 'GET') {
        const v = store.get<{ path: string }>('SELECT path FROM videos WHERE id=?', Number(url.searchParams.get('video'))); if (!v) return json(res, 404, { error: 'unknown video' });
        return json(res, 200, { cues: loadTranscript(v.path.replace(/\.[^.]+$/, '')) });
      }
      if (p === '/api/transcript/edit' && m === 'POST') {
        const v = store.get<{ path: string }>('SELECT path FROM videos WHERE id=?', Number(url.searchParams.get('video'))); if (!v) return json(res, 404, { error: 'unknown video' });
        const b = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}') as { edits?: CueEdit[] }; if (!Array.isArray(b.edits) || !b.edits.length || b.edits.length > 500) return json(res, 400, { error: 'invalid: edits[] required (1..500)' });
        const base = v.path.replace(/\.[^.]+$/, ''); const next = applyCueEdits(loadTranscript(base), b.edits);
        writeFileSync(base + '.edited.json', JSON.stringify(next)); return json(res, 200, { ok: true, cues: next.length, note: 'saved as .edited.json (original transcript untouched); used by future renders' });
      }
      if (p === '/api/transcript' && m === 'POST') {
        const id = Number(url.searchParams.get('video')); const v = store.get<{ path: string }>('SELECT path FROM videos WHERE id=?', id); if (!v) return json(res, 404, { error: 'unknown video' });
        const fmt = url.searchParams.get('format'); if (!['srt', 'vtt', 'json'].includes(String(fmt))) return json(res, 400, { error: 'format must be srt|vtt|json' });
        const body = (await readBody(req, 5 * 1024 * 1024)).toString('utf8'); if (fmt === 'json') JSON.parse(body);
        writeFileSync(v.path.replace(/\.[^.]+$/, '') + '.' + fmt, body);
        store.exec(`UPDATE videos SET state='NEW', analysis_path=NULL WHERE id=?`, id); return json(res, 200, { ok: true, note: 'transcript saved; video queued for re-analysis' });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const err = e as Error & { status?: number }; const status = err.status ?? (/LOW_DISK/.test(err.message) ? 507 : /Unsupported|not found|ffprobe failed|Unexpected token|JSON|authorization required|only https|invalid|Unknown (clip|upload|channel)|only manual|nothing staged|unsupported VOD|oauth:|unsupported YouTube/i.test(err.message) ? 400 : 500);
      if (status >= 500) error('request failed', { path: p, err: err.message }); else warn('bad request', { path: p, err: err.message.slice(0, 120) });
      if (!res.headersSent) json(res, status, { error: status >= 500 ? 'internal error' : scrubError(err) }); else res.end();
    }
  };

  const runEnvApply = async (force = false) => { const r = await applyEnvKeys(cfg, { force }); const out = []; for (const x of r) { const slot = x.report?.llm?.slot ?? x.slot; const t = slot ? await testConnection(store, cfg, `llm:${slot}`).catch(() => null) : null; /* saved keys are re-tested at every start: "already saved" is not "works" */ out.push({ provider: x.provider, var: x.var, skipped: !!x.skipped, ok: x.skipped ? (t ? t.ok : true) : !!(x.report?.ok && (!t || t.ok)), model: x.report?.llm?.model ?? (slot ? llmSlot(cfg, slot)?.model ?? null : null), detail: x.skipped ? (t && !t.ok ? t.detail : 'already saved') : (x.report?.steps.filter((y) => !y.ok).slice(-1)[0]?.text ?? t?.detail ?? '') }); } return out; };
  const server = createServer((req, res) => { void handler(req, res); });
  server.requestTimeout = 0; server.headersTimeout = 30_000;
  return {
    server, cfg, store, runOnce, bootstrap: async () => { try { return await bootstrapTools(store, cfg); } catch { return null; } }, get running() { return running; }, applyEnv: async (force) => { try { const r = await runEnvApply(!!force); for (const x of r) info('env key', { provider: x.provider, var: x.var, ok: x.ok, model: x.model, detail: x.ok ? undefined : x.detail }); { const okK = r.filter((x) => x.ok), badK = r.filter((x) => !x.ok); info(okK.length ? `KEYS SUMMARY: ${okK.length}/${r.length} chal rahi hain (${okK.map((x) => x.provider).join(', ')}) - itni kaafi hain, baaki hata sakte ho` : 'KEYS SUMMARY: ek bhi AI key nahi chal rahi - Setup me free Gemini key (aistudio.google.com/apikey) daalo', { band: badK.map((x) => x.var).join(', ') || undefined }); } if (sttCreds(cfg)) { const t = await testConnection(store, cfg, 'stt').catch(() => null); if (t) info('stt key', { ok: t.ok, ...(t.ok ? {} : { detail: t.detail, fix: /pahunch nahi|fetch failed|timed out|timeout|network|ENOTFOUND|EAI_AGAIN/i.test(t.detail) ? 'Internet/server tak pahunch nahi paya - key ka koi dosh nahi, net aane par ye apne aap dobara check hoga. Tab tak local whisper / Gemini audio chalega' : 'Speech-to-text key reject hui: provider ke dashboard (Groq: console.groq.com/keys) se naya key banao aur .env me badlo. Tab tak local whisper / Gemini audio chalega' }) }); } try { const { pickLocal } = await import('../analysis/localStt.ts'); const pk = await pickLocal(cfg); info('local stt', { engine: pk?.id ?? 'none', ...(pk?.id === 'faster-whisper' ? {} : { tip: 'PC/server par `pip install faster-whisper` 4-6x tez local STT deta hai (Termux/Android par ye install nahi hota: whisper.cpp use hota hai)' }) }); } catch { /* informational */ } return r; } catch (e) { warn('env apply failed', { err: (e as Error).message }); return []; } },
    start: () => new Promise<number>((ok, bad) => {
      server.once('error', bad);
      try { resumeStudio(store, cfg, o.studioDeps); } catch { /* studio tables missing is impossible after migrate; never block start */ }
      server.listen(o.port ?? Number(process.env.PORT ?? 8080), host, () => {
        const port = (server.address() as { port: number }).port;
        if (o.autoRun ?? process.env.AUTO_RUN !== '0') { const every = (o.loopSeconds ?? Number(process.env.LOOP_SECONDS ?? 30)) * 1000; timer = setInterval(() => { if (!stopping) void runOnce(); }, every); void runOnce(); }
        info('server listening', { host, port, auth: token ? 'token' : 'none(loopback)', autoRun: !!timer }); ok(port);
      });
    }),
    stop: async () => { stopping = true; if (timer) clearInterval(timer); await new Promise<void>((r) => { server.close(() => r()); server.closeIdleConnections?.(); }); await Promise.race([current ?? Promise.resolve(), new Promise((r) => setTimeout(r, 25_000))]); store.close(); },
  };
}
