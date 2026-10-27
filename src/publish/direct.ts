import { fitCaption } from '../seo/brief.ts';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Store } from '../db.ts';
import type { SecretStore } from './secrets.ts';
import type { Adapter } from './machine.ts';

/**
 * Platform registry. kind:
 *  - 'api-upload'  YouTube (private upload -> verify -> publish, handled by YouTubeAdapter)
 *  - 'direct'      owner-supplied token/webhook; ONE request posts the clip (staged first, sent only at the publish step, gates apply)
 *  - 'manual'      no usable free posting API from here (or ToS forbids bots): the system prepares file + caption + schedule and
 *                  raises a "post now" task; the owner posts it and marks it done (optional URL). Never logs in with a password.
 */
export type PlatformKind = 'api-upload' | 'direct' | 'manual' | 'oauth';
export interface PlatformInfo { id: string; label: string; kind: PlatformKind; secret?: string; app?: 'facebook' | 'tiktok'; openUrl?: string; fields?: { name: string; label: string; secret?: boolean }[]; note: string }
export const PLATFORMS: PlatformInfo[] = [
  { id: 'youtube_shorts', label: 'YouTube Shorts', kind: 'api-upload', note: 'OAuth (device flow) per channel; real adapter, tested against a fake Google only.' },
  { id: 'telegram', label: 'Telegram channel/group', kind: 'direct', secret: 'telegram', fields: [{ name: 'botToken', label: 'Bot token (from @BotFather)', secret: true }, { name: 'chatId', label: 'Chat id or @channelname' }], note: 'Bot must be admin of the channel. Fake-tested only.' },
  { id: 'discord', label: 'Discord channel', kind: 'direct', secret: 'discord', fields: [{ name: 'webhookUrl', label: 'Webhook URL', secret: true }], note: 'Channel webhook; file size limit of the server applies. Fake-tested only.' },
  { id: 'mastodon', label: 'Mastodon', kind: 'direct', secret: 'mastodon', fields: [{ name: 'instance', label: 'Instance URL (https://...)' }, { name: 'accessToken', label: 'Access token (write:media write:statuses)', secret: true }], note: 'Fake-tested only.' },
  { id: 'instagram_reels', label: 'Instagram Reels', kind: 'oauth', app: 'facebook', openUrl: 'https://www.instagram.com/', note: 'Login with Facebook (Instagram professional account linked to a Page). Uploads Reels through Meta Graph API once logged in; until then a manual task. Meta docs read 2026-10-25; never run against real Meta.' },
  { id: 'facebook_reels', label: 'Facebook Reels', kind: 'oauth', app: 'facebook', openUrl: 'https://www.facebook.com/reels/create', note: 'Login with Facebook (Page admin). Uploads Reels to the Page through Meta Graph API once logged in; until then a manual task. Meta docs read 2026-10-25; never run against real Meta.' },
  { id: 'tiktok', label: 'TikTok', kind: 'manual', app: 'tiktok', openUrl: 'https://www.tiktok.com/upload', note: 'Direct Post API needs app audit (unaudited apps post private only); manual task.' },
  { id: 'x', openUrl: 'https://x.com/compose/post', label: 'X (Twitter)', kind: 'manual', note: 'Paid API; manual task.' },
  { id: 'linkedin', openUrl: 'https://www.linkedin.com/feed/', label: 'LinkedIn', kind: 'manual', note: 'Manual task.' },
  { id: 'pinterest', openUrl: 'https://www.pinterest.com/pin-creation-tool/', label: 'Pinterest', kind: 'manual', note: 'Manual task.' },
  { id: 'snapchat', openUrl: 'https://www.snapchat.com/', label: 'Snapchat Spotlight', kind: 'manual', note: 'Manual task.' },
  { id: 'threads', openUrl: 'https://www.threads.net/', label: 'Threads', kind: 'manual', note: 'Manual task.' },
  { id: 'bluesky', openUrl: 'https://bsky.app/', label: 'Bluesky', kind: 'manual', note: 'Manual task (adapter not built).' },
  { id: 'reddit', openUrl: 'https://www.reddit.com/submit', label: 'Reddit', kind: 'manual', note: 'Manual task.' },
];
export const platformInfo = (id: string) => PLATFORMS.find((p) => p.id === id);
export const isManual = (id: string) => { const k = platformInfo(id)?.kind; return k === 'manual' || k === 'oauth'; };

const uploadKey = (k: string) => `sent:${k}`;
const safeHttp = (u: string, what: string, hosts?: RegExp) => {
  let x: URL; try { x = new URL(u); } catch { throw new Error(`invalid: ${what} is not a URL`); }
  const loop = x.hostname === '127.0.0.1' || x.hostname === 'localhost';
  if (!(x.protocol === 'https:' || (x.protocol === 'http:' && loop && process.env.YT_CLIPS_ALLOW_LOOPBACK_HTTP === '1'))) throw new Error(`invalid: ${what} must be https`);
  if (hosts && !hosts.test(x.hostname) && !(loop && process.env.YT_CLIPS_ALLOW_LOOPBACK_HTTP === '1')) throw new Error(`invalid: ${what} host not allowed`);
  return x;
};
/** Validates + stores platform credentials (write-only; never echoed). */
export function saveCredentials(secrets: SecretStore, platform: string, v: Record<string, unknown>, name?: string): void {
  const info = platform === 'notify' ? { kind: 'direct', secret: 'notify' } : platformInfo(platform); if (!info || info.kind !== 'direct' || !info.secret) throw new Error('invalid: this platform takes no stored credentials');
  const s = (k: string, max = 600) => { const x = v[k]; if (typeof x !== 'string' || x.trim().length < 3 || x.length > max) throw new Error(`invalid: ${k}`); return x.trim(); };
  let out: Record<string, unknown>;
  if (platform === 'telegram' || platform === 'notify') { const botToken = s('botToken', 200), chatId = s('chatId', 100); if (!/^\d{5,}:[\w-]{20,}$/.test(botToken)) throw new Error('invalid: botToken format'); if (!/^(-?\d{5,20}|@[\w]{4,64})$/.test(chatId)) throw new Error('invalid: chatId format'); out = { botToken, chatId }; }
  else if (platform === 'discord') { const u = safeHttp(s('webhookUrl'), 'webhookUrl', /(^|\.)(discord|discordapp)\.com$/i); if (!/^\/api\/webhooks\/\d+\/[\w-]+/.test(u.pathname)) throw new Error('invalid: webhookUrl path'); out = { webhookUrl: u.toString() }; }
  else { const u = safeHttp(s('instance'), 'instance'); out = { instance: u.origin, accessToken: s('accessToken', 400) }; }
  secrets.write(name ?? info.secret, out);
}
export const credentialsConfigured = (secrets: SecretStore, platform: string, name?: string) => { const i = platformInfo(platform); if (!i?.secret) return false; try { return !!secrets.read(name ?? i.secret) || (!!name && !!secrets.read(i.secret)); } catch { return false; } };

async function fileBlob(path: string, max: number): Promise<Blob> {
  const st = await stat(path); if (st.size > max) throw new Error(`file too large for this platform (${(st.size / 1e6).toFixed(1)} MB > ${(max / 1e6).toFixed(0)} MB)`);
  return new Blob([await readFile(path)], { type: 'video/mp4' });
}
async function http(url: string, init: RequestInit): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000), redirect: 'error' }); let json: any = null; try { json = await r.json(); } catch { /* empty body */ }
  return { status: r.status, json };
}

/** Adapters for 'direct' platforms. upload() only STAGES (no network); the one real request happens in publish(), after the gates. */
export abstract class StagedAdapter implements Adapter {
  abstract readonly name: string; protected store: Store; protected cred: Record<string, string>; protected sent = new Map<string, { file: string; title: string; description: string }>();
  constructor(store: Store, cred: Record<string, string>) { this.store = store; this.cred = cred; }
  private staged(id: string) { const raw = this.store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `stage:${id}`)?.v; return raw ? JSON.parse(raw) as { file: string; title: string; description: string } : null; }
  async upload(a: Parameters<Adapter['upload']>[0]) {
    const id = `${this.name}:${a.idempotencyKey}`;
    this.store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `stage:${id}`, JSON.stringify({ file: a.filePath, title: a.title, description: a.description }));
    return { remoteId: id };
  }
  async verify(id: string, expect?: { title: string }) { const s = this.staged(id); return { processed: !!s, metadataMatches: !!s && (!expect || s.title === expect.title), visibility: 'unlisted' }; }
  async publish(id: string, at: Date | null): Promise<{ remoteId?: string } | void> {
    if (at && at.getTime() > Date.now()) throw new Error(`WAIT_SCHEDULE: due ${at.toISOString()}`); // local scheduling: the worker loop retries until the slot
    const done = this.store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', uploadKey(id))?.v; if (done) return { remoteId: done }; // idempotent: never double-post after a crash
    const s = this.staged(id); if (!s) throw new Error(`NOT_READY: nothing staged for ${id}`);
    const remote = await this.send(s, id);
    this.store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, uploadKey(id), remote);
    return { remoteId: remote };
  }
  protected abstract send(s: { file: string; title: string; description: string }, id: string): Promise<string>;
}

export class TelegramAdapter extends StagedAdapter {
  readonly name = 'telegram';
  protected async send(s: { file: string; title: string; description: string }) {
    const base = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'; const fd = new FormData();
    fd.set('chat_id', this.cred.chatId!); fd.set('supports_streaming', 'true');
    fd.set('caption', fitCaption(s.title, s.description, 1024)); fd.set('video', await fileBlob(s.file, 50 * 1024 * 1024), basename(s.file));
    const r = await http(`${base}/bot${this.cred.botToken}/sendVideo`, { method: 'POST', body: fd });
    if (r.status === 429) throw new Error(`NOT_READY: telegram rate limit (retry_after ${r.json?.parameters?.retry_after ?? '?'}s)`);
    if (r.status === 401 || r.status === 403) throw new Error('AUTH_TELEGRAM: bot token invalid or bot not allowed in this chat');
    if (!r.json?.ok) throw new Error(`telegram error ${r.status}: ${String(r.json?.description ?? '').slice(0, 120)}`);
    return `telegram:${r.json.result?.chat?.id ?? this.cred.chatId}:${r.json.result?.message_id}`;
  }
}
export class DiscordAdapter extends StagedAdapter {
  readonly name = 'discord';
  protected async send(s: { file: string; title: string; description: string }) {
    const u = safeHttp(this.cred.webhookUrl!, 'webhookUrl', /(^|\.)(discord|discordapp)\.com$/i); u.searchParams.set('wait', 'true'); const fd = new FormData();
    fd.set('payload_json', JSON.stringify({ content: fitCaption(`**${s.title}**`, s.description, 2000), allowed_mentions: { parse: [] } })); fd.set('files[0]', await fileBlob(s.file, 25 * 1024 * 1024), basename(s.file));
    const r = await http(u.toString(), { method: 'POST', body: fd });
    if (r.status === 429) throw new Error(`NOT_READY: discord rate limit (retry_after ${r.json?.retry_after ?? '?'}s)`);
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error('AUTH_DISCORD: webhook invalid or deleted');
    if (r.status >= 300 || !r.json?.id) throw new Error(`discord error ${r.status}: ${String(r.json?.message ?? '').slice(0, 120)}`);
    return `discord:${r.json.id}`;
  }
}
export class MastodonAdapter extends StagedAdapter {
  readonly name = 'mastodon';
  protected async send(s: { file: string; title: string; description: string }, id: string) {
    const base = safeHttp(this.cred.instance!, 'instance').origin; const auth = { authorization: `Bearer ${this.cred.accessToken}` };
    const fd = new FormData(); fd.set('file', await fileBlob(s.file, 40 * 1024 * 1024), basename(s.file)); fd.set('description', s.title.slice(0, 1500));
    const m = await http(`${base}/api/v2/media`, { method: 'POST', headers: auth, body: fd });
    if (m.status === 401 || m.status === 403) throw new Error('AUTH_MASTODON: token invalid / missing scopes');
    if (m.status !== 200 && m.status !== 202) throw new Error(`mastodon media error ${m.status}: ${String(m.json?.error ?? '').slice(0, 120)}`);
    const mediaId = String(m.json.id);
    if (m.status === 202) { // async processing: poll up to ~60s, 206 = still processing, 200 = ready
      let ready = false; for (let i = 0; i < 30 && !ready; i++) { await new Promise((r) => setTimeout(r, Number(process.env.MASTODON_POLL_MS ?? 2000))); const g = await http(`${base}/api/v1/media/${mediaId}`, { headers: auth }); if (g.status === 200) ready = true; else if (g.status !== 206) throw new Error(`mastodon media poll error ${g.status}`); }
      if (!ready) throw new Error('NOT_READY: mastodon still processing the video');
    }
    const st = await http(`${base}/api/v1/statuses`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': id.slice(0, 120) }, body: JSON.stringify({ status: `${s.title}\n\n${s.description}`.slice(0, 480), media_ids: [mediaId], visibility: 'public' }) });
    if (st.status === 429) throw new Error('NOT_READY: mastodon rate limit');
    if (st.status >= 300 || !st.json?.id) throw new Error(`mastodon status error ${st.status}: ${String(st.json?.error ?? '').slice(0, 120)}`);
    return `mastodon:${st.json.url ?? st.json.id}`;
  }
}

/** Manual platforms: staging only. publish() raises a "post it yourself" task (state stays until the owner marks it posted). */
export class ManualAdapter implements Adapter {
  readonly name: string; readonly local = true; constructor(platform: string) { this.name = platform; }
  async upload(a: Parameters<Adapter['upload']>[0]) { return { remoteId: `manual:${a.idempotencyKey}` }; }
  async verify(_id: string) { return { processed: true, metadataMatches: true, visibility: 'unlisted' }; }
  async publish(_id: string, at: Date | null): Promise<void> {
    if (at && at.getTime() > Date.now()) throw new Error(`WAIT_SCHEDULE: due ${at.toISOString()}`);
    throw new Error('MANUAL_POST_REQUIRED: post this clip yourself (file + caption are ready), then press "Posted"');
  }
}

/** Owner confirms they posted a manual clip. No network. Optional URL (https only). */
export function markPosted(store: Store, uploadId: number, url?: string): void {
  const u = store.get<{ platform: string; state: string }>('SELECT platform, state FROM uploads WHERE id=?', uploadId); if (!u) throw new Error('Unknown upload');
  if (!isManual(u.platform)) throw new Error('invalid: only manual platforms can be marked posted');
  if (u.state !== 'SCHEDULED_OR_APPROVED') throw new Error('invalid: clip is not at the "ready to post" stage yet');
  let remote = `manual:${uploadId}`; if (url) { const x = safeHttp(url, 'url'); remote = x.toString().slice(0, 500); }
  store.exec(`UPDATE uploads SET state='PUBLISHED', remote_id=?, visibility='public', error=NULL, updated_at=datetime('now') WHERE id=?`, remote, uploadId);
  store.logState('upload', uploadId, 'SCHEDULED_OR_APPROVED', 'PUBLISHED', 'manual: owner confirmed posted');
}
