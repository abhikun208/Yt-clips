import { getChannel } from '../channels.ts';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run, which } from '../util/proc.ts';
import { ingestLocal } from './local.ts';
import { sourceSettings, permanentReason, notYet } from './sourcecfg.ts';
import { fetchCaptions } from './ytcaptions.ts';
import { info, warn } from '../util/log.ts';

export type YtKind = 'channel' | 'video';
const HOSTS = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/i;
/** Twitch/Kick VODs are accepted as single videos only (yt-dlp has extractors for both; NOT run against the real sites from this project's sandbox). */
const VOD_HOSTS = /^(www\.|m\.)?(twitch\.tv|kick\.com)$/i;

/** Accept only https YouTube URLs. Returns kind + normalized URL. Throws on anything else (no arbitrary-host fetching). */
export function parseYoutubeUrl(raw: string): { kind: YtKind; url: string; videoId?: string; web?: boolean } {
  let u: URL; try { u = new URL(raw.trim()); } catch { throw new Error('invalid URL'); }
  if (u.protocol === 'https:' && /^(www\.|player\.)?vimeo\.com$/i.test(u.hostname)) { // Vimeo (public / unlisted) as a single video; yt-dlp has the extractor (NOT run against the real site from this sandbox)
    const m = /^\/(?:video\/)?(\d{6,12})(?:\/([0-9a-f]{8,16}))?\/?$/i.exec(u.pathname); if (!m) throw new Error('unsupported Vimeo URL (use vimeo.com/ID or player.vimeo.com/video/ID)');
    return { kind: 'video', web: true, videoId: m[1], url: `https://vimeo.com/${m[1]}${m[2] ? '/' + m[2] : ''}` };
  }
  if (u.protocol === 'https:' && VOD_HOSTS.test(u.hostname)) {
    if (!/^\/(videos\/\d{5,14}|video\/[0-9a-f-]{20,40}|[\w.-]{2,40}\/(videos|clips)\/[\w-]{5,60})\/?$/i.test(u.pathname)) throw new Error('unsupported VOD URL (use a twitch.tv/videos/ID or kick.com/video/ID link)');
    return { kind: 'video', web: true, videoId: u.pathname.replace(/\/$/, '').split('/').pop(), url: `https://${u.hostname.replace(/^(www\.|m\.)/, '')}${u.pathname.replace(/\/$/, '')}` };
  }
  if (u.protocol !== 'https:' || !HOSTS.test(u.hostname)) throw new Error('only https://youtube.com or youtu.be URLs are allowed');
  const id = u.hostname.toLowerCase().endsWith('youtu.be') ? u.pathname.slice(1) : u.pathname === '/watch' ? (u.searchParams.get('v') ?? '') : u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] ?? '' : '';
  if (id) { if (!/^[\w-]{6,20}$/.test(id)) throw new Error('invalid video id'); return { kind: 'video', videoId: id, url: `https://www.youtube.com/watch?v=${id}` }; }
  if (u.pathname === '/playlist') { const l = u.searchParams.get('list'); if (!l || !/^[\w-]{10,60}$/.test(l)) throw new Error('invalid playlist'); return { kind: 'channel', url: `https://www.youtube.com/playlist?list=${l}` }; }
  if (!/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)(\/(videos|shorts|streams))?\/?$/.test(u.pathname)) throw new Error('unsupported YouTube URL (use a channel, @handle, playlist or video link)');
  return { kind: 'channel', url: `https://www.youtube.com${u.pathname.replace(/\/$/, '')}${/\/(videos|shorts|streams)$/.test(u.pathname) ? '' : '/videos'}` };
}

export const ytdlpAvailable = () => which('yt-dlp');
/** Extra yt-dlp flags from the operator (e.g. `--js-runtimes node` when YouTube extraction needs a JS runtime). Whitespace-separated; never taken from API input. */
let jsRt: string[] | null = null;
/** Newer yt-dlp needs a JS runtime for YouTube; we hand it node (already required by this project) when the installed yt-dlp supports the flag. Cookies file via YT_DLP_COOKIES (for "confirm you're not a bot"). */
export async function prepareYtdlp(): Promise<void> { if (jsRt) return; jsRt = []; if (/--js-runtimes/.test(process.env.YT_DLP_EXTRA_ARGS ?? '')) return; const h = await run('yt-dlp', ['--help'], { timeoutMs: 20_000 }).catch(() => null); if (h && /--js-runtimes/.test(h.stdout)) jsRt = ['--js-runtimes', 'node']; }
/** Cookies file: YT_DLP_COOKIES, else `<data dir>/cookies.txt` if the owner dropped one there (Netscape format, exported from a logged-in browser). */
const cookiesFile = (): string | null => { const e = process.env.YT_DLP_COOKIES; if (e) return e; const f = join(process.env.YT_CLIPS_DATA_DIR ?? 'data', 'cookies.txt'); return existsSync(f) ? f : null; };
const extra = (): string[] => { const ck = cookiesFile(); return [...(jsRt ?? []), ...(ck ? ['--cookies', ck] : []), ...(process.env.YT_DLP_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean)]; };
/** YouTube often answers "403 Forbidden" / "confirm you're not a bot" for one client type and not for another: after a failure the download is retried with other player clients before giving up. */
export const YT_CLIENT_LADDER: string[][] = [[], ['--extractor-args', 'youtube:player_client=tv_simply,web_safari'], ['--extractor-args', 'youtube:player_client=android_vr'], ['--extractor-args', 'youtube:player_client=ios,mweb'], ['--force-ipv4', '--extractor-args', 'youtube:player_client=web_embedded']];
export const RETRY_WITH_OTHER_CLIENT = /403|forbidden|not a bot|sign in|cookies|nsig|signature|player response|format is not available|requested format|unable to extract|po.?token/i;

export interface Entry { id: string; title: string; duration: number | null }
export function parseEntries(stdout: string): Entry[] {
  const j = JSON.parse(stdout) as { entries?: Array<{ id?: string; title?: string; duration?: number | null } | null> };
  return (j.entries ?? []).filter((e): e is { id: string; title?: string; duration?: number | null } => !!e && typeof e.id === 'string' && /^[\w-]{6,20}$/.test(e.id)).map((e) => ({ id: e.id, title: e.title ?? e.id, duration: typeof e.duration === 'number' ? e.duration : null }));
}
export async function listChannelVideos(url: string, limit = 30, from = 1): Promise<Entry[]> {
  const r = await run('yt-dlp', [...extra(), '--flat-playlist', '--dump-single-json', ...(from > 1 ? ['--playlist-start', String(from)] : []), '--playlist-end', String(from + limit - 1), '--no-warnings', url], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`yt-dlp list failed: ${r.stderr.trim().slice(-200)}`);
  return parseEntries(r.stdout);
}
/**
 * Best-effort sidecars for clip selection: live-chat replay (`<base>.live_chat.json`) and the "most replayed" heatmap (`<base>.heatmap.json`).
 * Every failure is swallowed (not all videos have them). Never run against the real YouTube from this project's sandbox.
 */
export async function fetchSignals(url: string, base: string): Promise<{ chat: boolean; heatmap: boolean }> {
  const res = { chat: false, heatmap: false };
  try { await run('yt-dlp', [...extra(), '--skip-download', '--no-playlist', '--no-warnings', '--write-subs', '--sub-langs', 'live_chat', '-o', `${base}.%(ext)s`, url], { timeoutMs: 10 * 60_000 }); res.chat = existsSync(`${base}.live_chat.json`); } catch { /* optional */ }
  try {
    const r = await run('yt-dlp', [...extra(), '--skip-download', '--no-playlist', '--no-warnings', '--dump-single-json', url], { timeoutMs: 3 * 60_000 });
    if (r.code === 0) { const j = JSON.parse(r.stdout) as { heatmap?: unknown }; if (Array.isArray(j.heatmap) && j.heatmap.length >= 4) { writeFileSync(`${base}.heatmap.json`, JSON.stringify(j.heatmap)); res.heatmap = true; } }
  } catch { /* optional */ }
  return res;
}
export async function downloadVideo(url: string, dir: string, maxHeight: number, o: { strictH264?: boolean; name?: string; audioLang?: string; range?: { start: number; end: number } } = {}): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const fmt0 = o.strictH264 ? `bv*[height<=${maxHeight}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${maxHeight}][vcodec!^=av01][vcodec!^=vp09]+ba/b[height<=${maxHeight}][vcodec^=avc1]` : `bv*[height<=${maxHeight}][vcodec!^=av01]+ba/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`;
  const lang = o.audioLang && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(o.audioLang) ? o.audioLang : null; const fmt = lang ? `${fmt0.replace(/\+ba(\[ext=m4a\])?/g, `+ba[language^=${lang}]`)}/${fmt0}` : fmt0; // preferred audio track (e.g. the Hindi dub of a YouTube video), plain best audio if that track does not exist
  const sect = o.range && Number.isFinite(o.range.start) && o.range.end > o.range.start ? ['--download-sections', `*${Math.floor(o.range.start)}-${Math.ceil(o.range.end)}`, '--force-keyframes-at-cuts'] : [];
  const isYt = /youtu\.?be/i.test(url); const ladder = isYt && !/extractor-args/.test(process.env.YT_DLP_EXTRA_ARGS ?? '') ? YT_CLIENT_LADDER : [[]]; let lastErr = '';
  for (let i = 0; i < ladder.length; i++) {
    const r = await run('yt-dlp', [...extra(), ...ladder[i]!, '--retries', '5', '--fragment-retries', '10', '--socket-timeout', '30', '--no-playlist', '--no-warnings', ...sect, '-f', fmt, '--merge-output-format', 'mp4', '-o', join(dir, o.name ?? '%(id)s.%(ext)s'), '--print', 'after_move:filepath', url], { timeoutMs: 60 * 60_000 });
    const path = r.stdout.trim().split('\n').filter(Boolean).pop();
    if (r.code === 0 && path && existsSync(path)) { if (i > 0) info('yt-dlp worked with another player client', { attempt: i + 1 }); return path; }
    lastErr = r.stderr.trim().slice(-400);
    if (!RETRY_WITH_OTHER_CLIENT.test(lastErr)) break; // network/DNS/removed-video errors: another client will not help
  }
  throw new Error(`yt-dlp download failed: ${lastErr}`);
}

/** Register a source. Owner must confirm authorization; nothing is fetched from an unauthorized source. Idempotent per URL. */
/** "10:00-25:00", "1:02:03-1:30:00" or "600-1500" (seconds) -> { start, end }; null when empty; throws on nonsense. Max 4 hours. */
export function parseRange(raw: string | undefined | null): { start: number; end: number } | null {
  const t = String(raw ?? '').trim(); if (!t) return null;
  const sec = (x: string): number => { const p = x.trim().split(':').map(Number); if (!p.length || p.length > 3 || p.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('invalid time range: use 10:00-25:00'); return p.reduce((a, n) => a * 60 + n, 0); };
  const m = t.split('-'); if (m.length !== 2) throw new Error('invalid time range: use 10:00-25:00');
  const start = sec(m[0]!), end = sec(m[1]!); if (end <= start) throw new Error('invalid time range: end must be after start'); if (end - start > 4 * 3600) throw new Error('time range too long (max 4 hours)');
  return { start, end };
}
export function addYoutubeSource(store: Store, rawUrl: string, authorized: boolean, channelId?: number, opt: { audioLang?: string; range?: { start: number; end: number } | null } = {}): { id: number; kind: YtKind; duplicate: boolean } {
  if (!authorized) throw new Error('authorization required: confirm you own or have permission to reuse this content');
  const p = parseYoutubeUrl(rawUrl);
  const kind = p.kind === 'channel' ? 'youtube_channel' : 'youtube_video';
  const ex = store.get<{ id: number; status: string }>('SELECT id, status FROM sources WHERE uri=?', p.url);
  if (ex) { if (ex.status === 'removed') store.exec(`UPDATE sources SET status=?, meta_json=?, channel_id=COALESCE(?, channel_id) WHERE id=?`, p.kind === 'video' ? 'pending' : 'active', JSON.stringify(p.kind === 'video' ? { videoId: p.videoId, tries: 0, ...(opt.audioLang ? { audioLang: opt.audioLang } : {}), ...(opt.range ? { range: opt.range } : {}) } : {}), channelId ?? null, ex.id); return { id: ex.id, kind: p.kind, duplicate: ex.status !== 'removed' }; } // a removed link added again is switched back on
  const chId = channelId ?? store.get<{ id: number }>(`SELECT id FROM channels WHERE slug='main'`)!.id;
  const r = store.exec('INSERT INTO sources(kind, uri, title, authorized, status, meta_json, channel_id) VALUES (?,?,?,?,?,?,?)', kind, p.url, p.url, 1, p.kind === 'video' ? 'pending' : 'active', JSON.stringify(p.kind === 'video' ? { videoId: p.videoId, tries: 0, ...(opt.audioLang ? { audioLang: opt.audioLang } : {}), ...(opt.range ? { range: opt.range } : {}) } : {}), chId);
  return { id: r.lastId, kind: p.kind, duplicate: false };
}

export interface PollResult { discovered: number; downloaded: number; failed: number; skipped: number; error?: string; channels?: number }
/** Friendly cause for the usual yt-dlp failures (shown in the UI instead of a silent log line). */
/** DNS / no-route errors: the device is offline right now (phone WiFi/LTE switch, router restart). */
export const isOffline = (m: string): boolean => /Errno 7\b|Errno -[23]\b|No address associated|Temporary failure in name resolution|Name or service not known|Network is unreachable|EAI_AGAIN|ENETUNREACH|ENOTFOUND|getaddrinfo/i.test(m);
export function explainYtdlp(err: string): string {
  if (/not a bot|sign in to confirm|cookies/i.test(err)) return 'YouTube bot-check maang raha hai: browser se cookies export karke file banao aur .env mein YT_DLP_COOKIES=/path/cookies.txt likho';
  if (/JavaScript runtime|js.?runtime|n challenge|signature/i.test(err)) return 'yt-dlp purana hai ya JS runtime chahiye: `pip install -U yt-dlp` chalao';
  if (/HTTP Error 404|does not exist|not found|unavailable/i.test(err)) return 'Channel link galat ya channel/videos tab nahi mila';
  if (/Unable to download|getaddrinfo|Connection|timed out|Network/i.test(err)) return 'Internet/YouTube tak pahunch nahi paya';
  return err.slice(-200);
}

/** One bounded polling pass: discover new videos on authorized channels (newest first => new uploads first, backlog drained gradually), then download+ingest up to maxPerPoll. */
let polling = false;
/** Only one pass at a time: the timer tick and a manual 'poll now' used to run side by side and downloaded the same video twice. */
export async function pollSources(store: Store, cfg: Config): Promise<PollResult> {
  if (polling) return { discovered: 0, downloaded: 0, failed: 0, skipped: 0, error: 'poll already running' };
  polling = true; try { return await pollSourcesOnce(store, cfg); } finally { polling = false; }
}
async function pollSourcesOnce(store: Store, cfg: Config): Promise<PollResult> {
  const res: PollResult = { discovered: 0, downloaded: 0, failed: 0, skipped: 0 };
  if (!(await ytdlpAvailable())) return { ...res, error: 'yt-dlp not installed' };
  await prepareYtdlp();
  for (const ch of store.all<{ id: number; uri: string; channel_id: number | null; meta_json: string | null }>(`SELECT id, uri, channel_id, meta_json FROM sources WHERE kind='youtube_channel' AND status='active' AND authorized=1`)) {
    let cm: Record<string, unknown> = {}; try { cm = JSON.parse(ch.meta_json || '{}'); } catch { /* ignore */ }
    const set = sourceSettings(cm, cfg); const kk = `chpoll:${ch.id}`; const kv = (k: string): number => Number(store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v ?? 0);
    { const hrs = (ch.channel_id ? getChannel(store, ch.channel_id).config.checkEveryHours : undefined); const gap = set.checkMinutes > 0 ? set.checkMinutes * 60_000 : hrs ? hrs * 3600_000 : 0; // this source's own interval wins over the account's 6h/12h/24h
      if (gap) { if (Date.now() - kv(kk) < gap) continue; store.exec('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', kk, String(Date.now())); } }
    res.channels = (res.channels ?? 0) + 1;
    try {
      const known = !!store.get(`SELECT 1 FROM sources WHERE json_extract(meta_json,'$.channelSource')=?`, ch.id); // first scan of a channel = backlog; later new uploads are "fresh"
      const add = (list: Entry[], fresh: boolean): number => { let n = 0; for (const e of list) {
        const url = `https://www.youtube.com/watch?v=${e.id}`;
        if (store.get('SELECT 1 FROM sources WHERE uri=?', url)) continue;
        const tooLong = e.duration !== null && e.duration > set.maxDurationMin * 60;
        store.exec('INSERT INTO sources(kind, uri, title, authorized, status, meta_json, channel_id) VALUES (?,?,?,?,?,?,?)', 'youtube_video', url, e.title, 1, tooLong ? 'skipped' : 'pending', JSON.stringify({ videoId: e.id, channelSource: ch.id, duration: e.duration, tries: 0, fresh, ...(tooLong ? { reason: 'longer than maxDurationMin' } : {}) }), ch.channel_id);
        if (tooLong) res.skipped++; else { res.discovered++; n++; }
      } return n; };
      const added = add(await listChannelVideos(ch.uri, set.scanDepth), known);
      // nothing new and nothing waiting -> reach further back into the channel's OLD videos (page by page) so the queue never runs dry
      const waiting = store.get<{ n: number }>(`SELECT COUNT(*) n FROM sources WHERE kind='youtube_video' AND status='pending' AND json_extract(meta_json,'$.channelSource')=?`, ch.id)?.n ?? 0;
      if (set.backlog && !added && !waiting) {
        const fk = `chfrom:${ch.id}`; const end = kv(`chend:${ch.id}`); const from = Math.max(set.scanDepth + 1, kv(fk) || set.scanDepth + 1);
        if (!end) { const older = await listChannelVideos(ch.uri, set.scanDepth, from); store.exec('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', fk, String(from + set.scanDepth));
          if (!older.length) { store.exec('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', `chend:${ch.id}`, '1'); info('channel ki saari purani videos scan ho chuki', { source: ch.id }); }
          else { const n = add(older, false); info('naya video nahi tha - purani videos queue me', { source: ch.id, found: n, from }); } }
      }
    } catch (e) { warn('channel listing failed', { channel: ch.uri, err: (e as Error).message }); res.error = explainYtdlp((e as Error).message); }
  }
  const cfgCache = new Map<number, ReturnType<typeof sourceSettings>>(); const parentCfg = (id: number) => { let c = cfgCache.get(id); if (!c) { const r = store.get<{ meta_json: string | null }>('SELECT meta_json FROM sources WHERE id=?', id); let m: Record<string, unknown> = {}; try { m = JSON.parse(r?.meta_json || '{}'); } catch { /* ignore */ } c = sourceSettings(m, cfg); cfgCache.set(id, c); } return c; };
  const all = store.all<{ id: number; uri: string; title: string; meta_json: string }>(`SELECT id, uri, title, meta_json FROM sources WHERE kind='youtube_video' AND status='pending' AND authorized=1 ORDER BY id LIMIT 2000`);
  type M = { tries?: number; fresh?: boolean; channelSource?: number; retryAfter?: number };
  const rows = all.map((v) => ({ v, m: JSON.parse(v.meta_json || '{}') as M })).filter((x) => !(x.m.retryAfter && x.m.retryAfter > Date.now()));
  // order: videos that never failed first, then NEW uploads before old ones, then newest (or oldest) per the channel's own setting
  const pickFor = (x: { m: M }) => (x.m.channelSource ? parentCfg(x.m.channelSource) : null);
  rows.sort((a, b) => (a.m.tries ?? 0) - (b.m.tries ?? 0) || Number(!!b.m.fresh) - Number(!!a.m.fresh) || (pickFor(a)?.order === 'oldest' ? b.v.id - a.v.id : a.v.id - b.v.id));
  const taken = new Map<number, number>(); const pending: typeof all = []; // the per-source quota is spent on real download attempts (skips of dead videos are free), checked inside the loop
  for (const x of rows) { const pc = pickFor(x); if (pc && !pc.backlog && !x.m.fresh) continue; pending.push(x.v); }
  for (const v of pending) {
    const meta = JSON.parse(v.meta_json || '{}') as { tries?: number; channelSource?: number; audioLang?: string; range?: { start: number; end: number } };
    const par = meta.channelSource ?? 0; const lim = par ? parentCfg(par).perPoll : cfg.youtube.maxPerPoll; if ((taken.get(par) ?? 0) >= lim) continue;
    let file: string | undefined;
    try {
      taken.set(par, (taken.get(par) ?? 0) + 1);
      file = await downloadVideo(v.uri, join(cfg.dirs.tmp, 'dl'), cfg.youtube.maxHeight, { ...(meta.audioLang ? { audioLang: meta.audioLang } : {}), ...(meta.range ? { range: meta.range } : {}) });
      if (!meta.range) { // chat/heatmap/captions describe the WHOLE video: their timestamps would not match a cut-out time range
      try { await fetchSignals(v.uri, file.replace(/\.[^.]+$/, '')); } catch { /* optional */ }
      if (cfg.stt.youtubeCaptions !== false && cfg.stt.mode === 'auto') { const lang = await fetchCaptions(v.uri, file.replace(/\.[^.]+$/, ''), extra()); if (lang) info('YouTube captions mil gaye - speech-to-text model chalane ki zaroorat nahi (key-free, instant)', { uri: v.uri, lang }); } }
      await ingestLocal(store, cfg, file, { authorized: true, title: v.title, sourceId: v.id });
      store.exec(`UPDATE sources SET status='done' WHERE id=?`, v.id); res.downloaded++; info('downloaded source', { uri: v.uri });
    } catch (e) {
      const msg = (e as Error).message.replace(/\r/g, '\n');
      if (isOffline(msg)) { // no internet is not this video's fault: keep it pending, do not use up an attempt, do not hammer the other videos
        warn('internet nahi hai - download baad me dobara try hoga (koi attempt kharch nahi hua)', { uri: v.uri }); res.error = 'offline'; break;
      }
      const perm = permanentReason(msg); // members-only / private / removed: retrying can never work -> skip with a reason, the queue moves on
      if (perm) { taken.set(par, (taken.get(par) ?? 1) - 1); store.exec(`UPDATE sources SET status='skipped', meta_json=? WHERE id=?`, JSON.stringify({ ...meta, reason: perm }), v.id); res.skipped++; warn('video skip', { uri: v.uri, why: perm }); continue; }
      if (notYet(msg)) { taken.set(par, (taken.get(par) ?? 1) - 1); store.exec(`UPDATE sources SET meta_json=? WHERE id=?`, JSON.stringify({ ...meta, retryAfter: Date.now() + 6 * 3600_000, reason: 'premiere/live abhi shuru nahi hui - 6 ghante baad dobara' }), v.id); warn('video abhi live/premiere nahi hui', { uri: v.uri }); continue; }
      const tries = (meta.tries ?? 0) + 1; const dead = tries >= cfg.resources.jobMaxAttempts;
      store.exec(`UPDATE sources SET status=?, meta_json=? WHERE id=?`, dead ? 'failed' : 'pending', JSON.stringify({ ...meta, tries, lastError: explainYtdlp((e as Error).message) }), v.id);
      res.failed++; warn('download failed', { uri: v.uri, tries, why: explainYtdlp(msg) });
    } finally { if (file) rmSync(file, { force: true }); }
  }
  store.exec(`INSERT INTO kv(k,v) VALUES('poll:last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, JSON.stringify({ at: new Date().toISOString(), ...res }));
  return res;
}
