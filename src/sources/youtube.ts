import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run, which } from '../util/proc.ts';
import { ingestLocal } from './local.ts';
import { info, warn } from '../util/log.ts';

export type YtKind = 'channel' | 'video';
const HOSTS = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/i;
/** Twitch/Kick VODs are accepted as single videos only (yt-dlp has extractors for both; NOT run against the real sites from this project's sandbox). */
const VOD_HOSTS = /^(www\.|m\.)?(twitch\.tv|kick\.com)$/i;

/** Accept only https YouTube URLs. Returns kind + normalized URL. Throws on anything else (no arbitrary-host fetching). */
export function parseYoutubeUrl(raw: string): { kind: YtKind; url: string; videoId?: string; web?: boolean } {
  let u: URL; try { u = new URL(raw.trim()); } catch { throw new Error('invalid URL'); }
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
const extra = (): string[] => (process.env.YT_DLP_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean);

export interface Entry { id: string; title: string; duration: number | null }
export function parseEntries(stdout: string): Entry[] {
  const j = JSON.parse(stdout) as { entries?: Array<{ id?: string; title?: string; duration?: number | null } | null> };
  return (j.entries ?? []).filter((e): e is { id: string; title?: string; duration?: number | null } => !!e && typeof e.id === 'string' && /^[\w-]{6,20}$/.test(e.id)).map((e) => ({ id: e.id, title: e.title ?? e.id, duration: typeof e.duration === 'number' ? e.duration : null }));
}
export async function listChannelVideos(url: string, limit = 30): Promise<Entry[]> {
  const r = await run('yt-dlp', [...extra(), '--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), '--no-warnings', url], { timeoutMs: 5 * 60_000 });
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
export async function downloadVideo(url: string, dir: string, maxHeight: number): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const r = await run('yt-dlp', [...extra(), '--no-playlist', '--no-warnings', '-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`, '--merge-output-format', 'mp4', '-o', join(dir, '%(id)s.%(ext)s'), '--print', 'after_move:filepath', url], { timeoutMs: 60 * 60_000 });
  const path = r.stdout.trim().split('\n').filter(Boolean).pop();
  if (r.code !== 0 || !path || !existsSync(path)) throw new Error(`yt-dlp download failed: ${r.stderr.trim().slice(-200)}`);
  return path;
}

/** Register a source. Owner must confirm authorization; nothing is fetched from an unauthorized source. Idempotent per URL. */
export function addYoutubeSource(store: Store, rawUrl: string, authorized: boolean, channelId?: number): { id: number; kind: YtKind; duplicate: boolean } {
  if (!authorized) throw new Error('authorization required: confirm you own or have permission to reuse this content');
  const p = parseYoutubeUrl(rawUrl);
  const kind = p.kind === 'channel' ? 'youtube_channel' : 'youtube_video';
  const ex = store.get<{ id: number }>('SELECT id FROM sources WHERE uri=?', p.url);
  if (ex) return { id: ex.id, kind: p.kind, duplicate: true };
  const chId = channelId ?? store.get<{ id: number }>(`SELECT id FROM channels WHERE slug='main'`)!.id;
  const r = store.exec('INSERT INTO sources(kind, uri, title, authorized, status, meta_json, channel_id) VALUES (?,?,?,?,?,?,?)', kind, p.url, p.url, 1, p.kind === 'video' ? 'pending' : 'active', JSON.stringify(p.kind === 'video' ? { videoId: p.videoId, tries: 0 } : {}), chId);
  return { id: r.lastId, kind: p.kind, duplicate: false };
}

export interface PollResult { discovered: number; downloaded: number; failed: number; skipped: number; error?: string }

/** One bounded polling pass: discover new videos on authorized channels (newest first => new uploads first, backlog drained gradually), then download+ingest up to maxPerPoll. */
export async function pollSources(store: Store, cfg: Config): Promise<PollResult> {
  const res: PollResult = { discovered: 0, downloaded: 0, failed: 0, skipped: 0 };
  if (!(await ytdlpAvailable())) return { ...res, error: 'yt-dlp not installed' };
  for (const ch of store.all<{ id: number; uri: string; channel_id: number | null }>(`SELECT id, uri, channel_id FROM sources WHERE kind='youtube_channel' AND status='active' AND authorized=1`)) {
    try {
      for (const e of await listChannelVideos(ch.uri, 30)) {
        const url = `https://www.youtube.com/watch?v=${e.id}`;
        if (store.get('SELECT 1 FROM sources WHERE uri=?', url)) continue;
        const tooLong = e.duration !== null && e.duration > cfg.youtube.maxDurationMin * 60;
        store.exec('INSERT INTO sources(kind, uri, title, authorized, status, meta_json, channel_id) VALUES (?,?,?,?,?,?,?)', 'youtube_video', url, e.title, 1, tooLong ? 'skipped' : 'pending', JSON.stringify({ videoId: e.id, channelSource: ch.id, duration: e.duration, tries: 0, ...(tooLong ? { reason: 'longer than maxDurationMin' } : {}) }), ch.channel_id);
        if (tooLong) res.skipped++; else res.discovered++;
      }
    } catch (e) { warn('channel listing failed', { channel: ch.uri, err: (e as Error).message }); res.error = (e as Error).message; }
  }
  const pending = store.all<{ id: number; uri: string; title: string; meta_json: string }>(`SELECT id, uri, title, meta_json FROM sources WHERE kind='youtube_video' AND status='pending' AND authorized=1 ORDER BY id LIMIT ?`, cfg.youtube.maxPerPoll);
  for (const v of pending) {
    const meta = JSON.parse(v.meta_json || '{}') as { tries?: number };
    let file: string | undefined;
    try {
      file = await downloadVideo(v.uri, join(cfg.dirs.tmp, 'dl'), cfg.youtube.maxHeight);
      try { await fetchSignals(v.uri, file.replace(/\.[^.]+$/, '')); } catch { /* optional */ }
      await ingestLocal(store, cfg, file, { authorized: true, title: v.title, sourceId: v.id });
      store.exec(`UPDATE sources SET status='done' WHERE id=?`, v.id); res.downloaded++; info('downloaded source', { uri: v.uri });
    } catch (e) {
      const tries = (meta.tries ?? 0) + 1; const dead = tries >= cfg.resources.jobMaxAttempts;
      store.exec(`UPDATE sources SET status=?, meta_json=? WHERE id=?`, dead ? 'failed' : 'pending', JSON.stringify({ ...meta, tries, lastError: (e as Error).message.slice(0, 300) }), v.id);
      res.failed++; warn('download failed', { uri: v.uri, tries, err: (e as Error).message.slice(0, 150) });
    } finally { if (file) rmSync(file, { force: true }); }
  }
  return res;
}
