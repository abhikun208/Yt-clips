import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createWriteStream, createReadStream, existsSync, statSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { join, basename, resolve, sep } from 'node:path';
import { Store } from '../db.ts';
import { loadConfig, updateOwnerConfig, type Config } from '../config.ts';
import { ingestLocal } from '../sources/local.ts';
import { seedJobs, work } from '../pipeline.ts';
import { addYoutubeSource, pollSources, ytdlpAvailable } from '../sources/youtube.ts';
import { PRESETS, getPreset } from '../edit/captionPresets.ts';
import { presetPreview } from '../edit/preview.ts';
import { checkDisk, freeMb } from '../util/disk.ts';
import { info, warn, error } from '../util/log.ts';
import { UI_HTML } from './ui.ts';

export interface AppOptions { host?: string; port?: number; token?: string; dataDir?: string; autoRun?: boolean; loopSeconds?: number; maxUploadMb?: number; rootDir?: string; overrides?: Record<string, unknown> }
export interface App { server: Server; cfg: Config; store: Store; start(): Promise<number>; stop(): Promise<void>; runOnce(): Promise<void>; readonly running: boolean }

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const VERSION = '0.2.0';

function safeEq(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
function json(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(s);
}
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const safeName = (n: string) => basename(n).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload.mp4';
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.json': 'application/json' };

/** Create the app (HTTP API + UI + background worker). No dependencies. Gates are NOT configurable through the API. */
export function createApp(o: AppOptions = {}): App {
  const host = o.host ?? process.env.HOST ?? '127.0.0.1';
  const token = o.token ?? process.env.YT_CLIPS_TOKEN ?? '';
  if (!LOOPBACK.has(host) && !token) throw new Error('Refusing to listen on a non-loopback address without YT_CLIPS_TOKEN. Set YT_CLIPS_TOKEN (long random string).');
  if (token && token.length < 12) throw new Error('YT_CLIPS_TOKEN must be at least 12 characters.');
  const cfg = loadConfig(o.rootDir ?? process.cwd(), { dataDir: o.dataDir, overrides: o.overrides });
  const store = new Store(cfg.dbPath);
  const maxUpload = (o.maxUploadMb ?? Number(process.env.MAX_UPLOAD_MB ?? 2048)) * 1024 * 1024;
  const uploadDir = join(cfg.dataDir, 'uploads'); mkdirSync(uploadDir, { recursive: true });
  const previewDir = join(cfg.dirs.tmp, 'preview');
  let lastPoll = 0; let running = false; let stopping = false; let timer: NodeJS.Timeout | null = null; let current: Promise<void> | null = null;
  const fails = new Map<string, { n: number; t: number }>();

  async function runOnce(): Promise<void> {
    if (running) return current ?? Promise.resolve();
    running = true;
    current = (async () => {
      try {
        if (Date.now() - lastPoll >= cfg.youtube.pollMinutes * 60_000 && store.get(`SELECT 1 FROM sources WHERE kind IN ('youtube_channel','youtube_video') AND status IN ('active','pending')`)) { lastPoll = Date.now(); const pr = await pollSources(store, cfg); if (pr.discovered || pr.downloaded || pr.failed) info('source poll', pr as unknown as Record<string, unknown>); }
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
    const ck = /(?:^|;\s*)ytc_token=([^;]+)/.exec(String(req.headers.cookie ?? ''));
    return !!ck && safeEq(decodeURIComponent(ck[1]!), token);
  };
  const usedCookie = (req: IncomingMessage) => !String(req.headers.authorization ?? '').startsWith('Bearer ') && !req.headers['x-api-key'];

  function clipRows() {
    return store.all<{ id: number; output_id: string; edited_path: string; thumbnail_path: string | null; metadata_json: string | null; qc_pass: number | null; state: string; candidate_id: number }>(
      'SELECT id, output_id, edited_path, thumbnail_path, metadata_json, qc_pass, state, candidate_id FROM clips ORDER BY id DESC LIMIT 200').map((c) => {
      const md = c.metadata_json ? JSON.parse(c.metadata_json) : {}; const cand = store.get<{ start_sec: number; end_sec: number; category: string }>('SELECT start_sec, end_sec, category FROM candidates WHERE id=?', c.candidate_id);
      return { id: c.id, outputId: c.output_id, title: md.title ?? null, description: md.description ?? null, tags: md.tags ?? [], qcPass: !!c.qc_pass, state: c.state, category: cand?.category ?? null, duration: cand ? cand.end_sec - cand.start_sec : 0,
        video: `/files/edited/${c.output_id}.mp4`, thumb: c.thumbnail_path ? `/files/thumb/${c.output_id}.jpg` : null, srt: existsSync(join(cfg.dataDir, 'captions', `${c.output_id}.srt`)) ? `/files/captions/${c.output_id}.srt` : null };
    });
  }

  function serveFile(req: IncomingMessage, res: ServerResponse, kind: string, name: string) {
    const dirs: Record<string, string> = { edited: cfg.dirs.editedShorts, thumb: cfg.dirs.thumbnails, captions: join(cfg.dataDir, 'captions') };
    const dir = dirs[kind]; if (!dir || !/^[\w.-]+$/.test(name)) return json(res, 404, { error: 'not found' });
    const full = resolve(dir, name); if (!full.startsWith(resolve(dir) + sep) || !existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: 'not found' });
    const size = statSync(full).size; const ext = name.slice(name.lastIndexOf('.')); const type = MIME[ext] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    const base = { 'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=60' };
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
    const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname; const m = req.method ?? 'GET';
    res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (p === '/healthz') {
        const q = store.all<{ state: string; n: number }>('SELECT state, count(*) n FROM jobs GROUP BY state');
        return json(res, 200, { ok: true, version: VERSION, running, freeDiskMb: freeMb(cfg.dataDir), queue: Object.fromEntries(q.map((x) => [x.state, x.n])) });
      }
      if (p === '/' && m === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }); return void res.end(UI_HTML); }
      const ip = req.socket.remoteAddress ?? '?';
      const f = fails.get(ip); if (f && f.n >= 10 && Date.now() - f.t < 60_000) return json(res, 429, { error: 'too many failed attempts' });
      if (!authed(req)) { fails.set(ip, { n: (f && Date.now() - f.t < 60_000 ? f.n : 0) + 1, t: Date.now() }); return json(res, 401, { error: 'unauthorized' }); }
      // CSRF: cookie-authenticated state-changing requests must carry the custom header (cross-site forms can't set it).
      if (m !== 'GET' && token && usedCookie(req) && req.headers['x-ytc'] !== '1') return json(res, 403, { error: 'missing x-ytc header' });

      if (p === '/api/login' && m === 'POST') return json(res, 200, { ok: true }, token ? { 'set-cookie': `ytc_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` } : {});
      if (p === '/api/status') return json(res, 200, { running, version: VERSION, gates: cfg.gates, captionPreset: cfg.edit.captionPreset,
        videos: store.all('SELECT state, count(*) n FROM videos GROUP BY state'), jobs: store.all('SELECT state, count(*) n FROM jobs GROUP BY state'), clips: store.all('SELECT state, count(*) n FROM clips GROUP BY state'), uploads: store.all('SELECT state, count(*) n FROM uploads GROUP BY state') });
      if (p === '/api/clips') return json(res, 200, { clips: clipRows() });
      if (p === '/api/presets') return json(res, 200, { current: cfg.edit.captionPreset, presets: PRESETS.map((x) => ({ id: x.presetId, label: x.label, base: x.id, palette: x.palette.id, tags: x.tags, mode: x.mode })) });
      const pv = /^\/api\/presets\/([\w-]+)\/preview\.png$/.exec(p);
      if (pv) { if (!getPreset(pv[1]!)) return json(res, 404, { error: 'unknown preset' }); const lang = url.searchParams.get('lang') === 'hi' ? 'hi' : 'en'; const png = await presetPreview(previewDir, pv[1]!, lang); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' }); return void createReadStream(png).pipe(res); }
      const mf = /^\/api\/manifest\/([\w.-]+)$/.exec(p);
      if (mf) { const f2 = join(cfg.dirs.manifests, `${mf[1]}.json`); if (!existsSync(f2)) return json(res, 404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(readFileSync(f2)); }
      const fl = /^\/files\/(edited|thumb|captions)\/([^/]+)$/.exec(p); if (fl && (m === 'GET' || m === 'HEAD')) return serveFile(req, res, fl[1]!, fl[2]!);

      if (p === '/api/config' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as Record<string, unknown>; const patch: Record<string, unknown> = {};
        const known = new Set(['captionPreset', 'captionEmphasis', 'reframe']); for (const k of Object.keys(b)) if (!known.has(k)) return json(res, 400, { error: `key not allowed: ${k} (gates/publishing can only be changed by editing data/config.json on the server)` });
        if ('captionPreset' in b) { if (b.captionPreset !== 'none' && !getPreset(String(b.captionPreset))) return json(res, 400, { error: 'unknown caption preset' }); patch.captionPreset = b.captionPreset; }
        if ('captionEmphasis' in b) { if (!Array.isArray(b.captionEmphasis) || b.captionEmphasis.some((x) => typeof x !== 'string' || x.length > 40) || b.captionEmphasis.length > 50) return json(res, 400, { error: 'captionEmphasis must be <=50 short strings' }); patch.captionEmphasis = b.captionEmphasis; }
        if ('reframe' in b) { if (b.reframe !== 'crop' && b.reframe !== 'fit_blur') return json(res, 400, { error: 'reframe must be crop|fit_blur' }); patch.reframe = b.reframe; }
        updateOwnerConfig(cfg, { edit: patch }); Object.assign(cfg.edit, patch); return json(res, 200, { ok: true, edit: { captionPreset: cfg.edit.captionPreset, captionEmphasis: cfg.edit.captionEmphasis, reframe: cfg.edit.reframe } });
      }
      if (p === '/api/sources' && m === 'GET') return json(res, 200, { ytdlp: await ytdlpAvailable(), sources: store.all(`SELECT id, kind, uri, title, status, authorized FROM sources ORDER BY id DESC LIMIT 200`) });
      if (p === '/api/sources' && m === 'POST') {
        const b = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}') as { url?: string; authorized?: boolean };
        const r = addYoutubeSource(store, String(b.url ?? ''), b.authorized === true); lastPoll = 0; void runOnce(); return json(res, 200, { ok: true, ...r, ytdlp: await ytdlpAvailable() });
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
          const r = await ingestLocal(store, cfg, tmp, { authorized: true, title: safeName(url.searchParams.get('name') ?? '') });
          void runOnce(); return json(res, 200, { ok: true, videoId: r.videoId, duplicate: r.duplicate });
        } finally { rmSync(tmp, { force: true }); }
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
      const err = e as Error & { status?: number }; const status = err.status ?? (/LOW_DISK/.test(err.message) ? 507 : /Unsupported|not found|ffprobe failed|Unexpected token|JSON|authorization required|only https|invalid|unsupported YouTube/i.test(err.message) ? 400 : 500);
      if (status >= 500) error('request failed', { path: p, err: err.message }); else warn('bad request', { path: p, err: err.message.slice(0, 120) });
      if (!res.headersSent) json(res, status, { error: status >= 500 ? 'internal error' : err.message.slice(0, 200) }); else res.end();
    }
  };

  const server = createServer((req, res) => { void handler(req, res); });
  server.requestTimeout = 0; server.headersTimeout = 30_000;
  return {
    server, cfg, store, runOnce, get running() { return running; },
    start: () => new Promise<number>((ok, bad) => {
      server.once('error', bad);
      server.listen(o.port ?? Number(process.env.PORT ?? 8080), host, () => {
        const port = (server.address() as { port: number }).port;
        if (o.autoRun ?? process.env.AUTO_RUN !== '0') { const every = (o.loopSeconds ?? Number(process.env.LOOP_SECONDS ?? 30)) * 1000; timer = setInterval(() => { if (!stopping) void runOnce(); }, every); void runOnce(); }
        info('server listening', { host, port, auth: token ? 'token' : 'none(loopback)', autoRun: !!timer }); ok(port);
      });
    }),
    stop: async () => { stopping = true; if (timer) clearInterval(timer); await new Promise<void>((r) => { server.close(() => r()); server.closeIdleConnections?.(); }); await Promise.race([current ?? Promise.resolve(), new Promise((r) => setTimeout(r, 25_000))]); store.close(); },
  };
}
