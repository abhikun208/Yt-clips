import { buildAccountKit, type AccountKit } from '../seo/account.ts';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { advanceUpload, queueUpload, DryRunAdapter, type Adapter, type ClipFacts, type UploadState } from './machine.ts';
import { SecretStore } from './secrets.ts';
import { TokenProvider, clientCreds, startDeviceFlow, pollDeviceFlow, type DeviceStart } from './oauth.ts';
import { YouTubeAdapter } from './youtube.ts';
import { instagramProvider, facebookProvider, tiktokProvider, youtubeProvider, type Provider } from '../analytics/providers.ts';
import { screenText } from './safety.ts';
import { probe } from '../media/probe.ts';
import { ingestComment, postApprovedReply } from '../comments/comments.ts';
import { connectedScope, YT_FORCE_SSL_SCOPE, YT_ANALYTICS_SCOPE } from './oauth.ts';
import { tiktokAccessToken } from './socialOauth.ts';
import { FacebookReelsAdapter, InstagramReelsAdapter, metaCanPublish } from './meta.ts';
import { TelegramAdapter, DiscordAdapter, MastodonAdapter, ManualAdapter, isManual, platformInfo } from './direct.ts';
import { notify } from '../notify.ts';
import { planFromStore } from '../schedule/analytics.ts';
import { getChannel, listChannels, scheduleFor, ytSecretName, mainChannel, type Channel } from '../channels.ts';

export const secretsFor = (cfg: Config) => SecretStore.forData(cfg.dataDir);

/** Real facts about a rendered clip: dimensions/duration are PROBED from the edited file, metadata from the stored SEO step. Never invents values. */
export async function factsForClip(store: Store, clipId: number): Promise<ClipFacts> {
  const c = store.get<{ metadata_json: string | null; qc_pass: number | null; thumbnail_path: string | null; candidate_id: number; edited_path: string | null }>('SELECT metadata_json, qc_pass, thumbnail_path, candidate_id, edited_path FROM clips WHERE id=?', clipId);
  const tx = store.get<{ transcript: string | null }>('SELECT transcript FROM candidates WHERE id=?', c?.candidate_id ?? -1)?.transcript ?? '';
  if (!c) throw new Error(`Unknown clip ${clipId}`);
  if (!c.metadata_json) throw new Error('NOT_READY: metadata not generated yet for this clip');
  if (!c.edited_path) throw new Error('NOT_READY: clip not rendered yet');
  const md = JSON.parse(c.metadata_json) as { title: string; description: string; tags?: string[]; language?: string };
  const m = await probe(c.edited_path);
  const src = store.get<{ authorized: number | null }>('SELECT s.authorized FROM candidates c JOIN videos v ON v.id=c.video_id LEFT JOIN sources s ON s.id=v.source_id WHERE c.id=?', c.candidate_id);
  return { width: m.width, height: m.height, duration: m.duration, title: md.title, description: md.description, tags: md.tags ?? [], language: md.language, risks: screenText(`${md.title} ${md.description} ${tx}`), qcPass: !!c.qc_pass, authorized: src?.authorized == null ? true : src.authorized === 1, thumbnailPath: c.thumbnail_path };
}

/** Token provider for one channel's YouTube account (main keeps the legacy secret name `youtube`). */
export function tokenFor(cfg: Config, ch: Channel): TokenProvider { return new TokenProvider(secretsFor(cfg), ytSecretName(ch)); }
const channelByUpload = (store: Store, uploadId: number): Channel => { const r = store.get<{ channel_id: number | null }>('SELECT channel_id FROM uploads WHERE id=?', uploadId); return (r?.channel_id ? getChannel(store, r.channel_id) : null) ?? mainChannel(store); };

export function adapterFor(store: Store, cfg: Config, platform: string, ch?: Channel): Adapter {
  if (platform === 'dryrun') return new DryRunAdapter();
  if (platform === 'youtube_shorts' || platform === 'youtube') return new YouTubeAdapter(store, ch ? tokenFor(cfg, ch) : new TokenProvider(secretsFor(cfg)));
  if ((platform === 'facebook_reels' || platform === 'instagram_reels') && metaCanPublish(secretsFor(cfg), platform)) { const cred = secretsFor(cfg).read<Record<string, string>>(platform === 'facebook_reels' ? 'facebook' : 'instagram'); if (cred) return platform === 'facebook_reels' ? new FacebookReelsAdapter(store, cred) : new InstagramReelsAdapter(store, cred); }
  if (isManual(platform)) return new ManualAdapter(platform);
  const info = platformInfo(platform);
  if (info?.kind === 'direct' && info.secret) {
    const sec = secretsFor(cfg); const cred = (ch && sec.read<Record<string, string>>(`${info.secret}-${ch.slug}`)) || sec.read<Record<string, string>>(info.secret);
    if (!cred) throw new Error(`AUTH_NOT_CONNECTED: save the ${info.label} credentials first (Setup -> Platforms)`);
    return platform === 'telegram' ? new TelegramAdapter(store, cred) : platform === 'discord' ? new DiscordAdapter(store, cred) : new MastodonAdapter(store, cred);
  }
  throw new Error(`AUTH_NOT_CONNECTED: no adapter for platform "${platform}" (only youtube_shorts has a real adapter; others need owner credentials)`);
}

export function listUploads(store: Store) {
  return store.all(`SELECT u.id, u.clip_id, u.platform, u.state, u.remote_id, u.visibility, u.scheduled_at, u.error, u.updated_at, c.output_id, c.metadata_json, ch.slug AS channel, ch.name AS channel_name FROM uploads u JOIN clips c ON c.id=u.clip_id LEFT JOIN channels ch ON ch.id=u.channel_id ORDER BY u.id DESC LIMIT 200`).map((r) => { const x = r as Record<string, unknown>; let title = ''; try { title = (JSON.parse(String(x.metadata_json ?? '{}')) as { title?: string }).title ?? ''; } catch { /* no metadata */ } delete x.metadata_json; return { ...x, title }; });
}

export async function advance(store: Store, cfg: Config, uploadId: number, o: { approve?: boolean; scheduledAt?: Date | null } = {}): Promise<{ state: UploadState } | { state: string; blocked: string }> {
  const u = store.get<{ clip_id: number; platform: string; state: string }>('SELECT clip_id, platform, state FROM uploads WHERE id=?', uploadId);
  if (!u) throw new Error(`Unknown upload ${uploadId}`);
  const facts = await factsForClip(store, u.clip_id);
  try { return { state: await advanceUpload(store, cfg, adapterFor(store, cfg, u.platform, channelByUpload(store, uploadId)), uploadId, { facts, ...o }) }; }
  catch (e) { const m = (e as Error).message; if (/^(PUBLISH_DISABLED|PUBLIC_DISABLED|NEEDS_APPROVAL|NOT_READY|QUOTA_EXCEEDED|AUTH_|WAIT_SCHEDULE|MANUAL_POST_REQUIRED)/.test(m)) return { state: store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', uploadId)!.state, blocked: m }; throw e; }
}

export { queueUpload };

export function youtubeStatus(store: Store, cfg: Config, ch: Channel = mainChannel(store)) {
  const secrets = secretsFor(cfg); const tp = tokenFor(cfg, ch); const ad = new YouTubeAdapter(store, tp);
  return { clientConfigured: !!clientCreds(secrets), connected: tp.connected(), secretsEncrypted: secrets.encrypted, quota: { insertsUsed: ad.quotaUsed('insert'), unitsUsed: ad.quotaUsed('units') }, gates: { publishEnabled: cfg.gates.publishEnabled, publicVisibilityAllowed: cfg.gates.publicVisibilityAllowed } };
}
export async function youtubeConnectStart(store: Store, cfg: Config, ch: Channel = mainChannel(store)): Promise<DeviceStart> {
  const cc = clientCreds(secretsFor(cfg)); if (!cc) throw new Error('invalid: set YT_OAUTH_CLIENT_ID and YT_OAUTH_CLIENT_SECRET (Google Cloud "TVs and Limited Input devices" OAuth client) first');
  const d = await startDeviceFlow(cc.clientId); store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')`, ytDeviceKey(ch), d.device_code); return d;
}
const ytDeviceKey = (ch: Channel) => (ch.slug === 'main' ? 'yt_device_code' : `yt_device_code:${ch.slug}`);
export async function youtubeConnectPoll(store: Store, cfg: Config, ch: Channel = mainChannel(store)) {
  const cc = clientCreds(secretsFor(cfg)); if (!cc) throw new Error('invalid: OAuth client not configured');
  const row = store.get<{ v: string }>(`SELECT v FROM kv WHERE k=?`, ytDeviceKey(ch)); if (!row) throw new Error('invalid: start the connect flow first');
  const r = await pollDeviceFlow(secretsFor(cfg), cc.clientId, cc.clientSecret, row.v, ytSecretName(ch));
  if (r.status === 'ok') store.exec(`DELETE FROM kv WHERE k=?`, ytDeviceKey(ch));
  return { status: r.status };
}

/** Pull retention for PUBLISHED YouTube uploads of every channel whose token has the analytics scope. Read-only; one row per video per call. */
export async function collectRetention(store: Store, cfg: Config): Promise<{ videos: number; recorded: number; skipped: string[]; errors: string[] }> {
  const res = { videos: 0, recorded: 0, skipped: [] as string[], errors: [] as string[] }; const today = new Date().toISOString().slice(0, 10);
  for (const ch of listChannels(store)) {
    const sc = connectedScope(secretsFor(cfg), ytSecretName(ch)); if (!sc) continue;
    if (!sc.split(/\s+/).includes(YT_ANALYTICS_SCOPE)) { res.skipped.push(`${ch.slug}: no analytics scope (run youtube-connect-full)`); continue; }
    const ups = store.all<{ remote_id: string; updated_at: string }>(`SELECT remote_id, updated_at FROM uploads WHERE platform='youtube_shorts' AND COALESCE(channel_id, ?)=? AND remote_id IS NOT NULL AND state IN ('PUBLISHED','ANALYTICS_WAIT','ANALYZING','LEARNING','NEXT_CYCLE')`, mainChannel(store).id, ch.id);
    const ad = new YouTubeAdapter(store, tokenFor(cfg, ch)); res.videos += ups.length;
    for (const u of ups) {
      try {
        const start = (u.updated_at ?? today).slice(0, 10); const x = await ad.retention(u.remote_id, start > today ? today : start, today); if (!x) continue;
        store.exec('INSERT INTO retention(platform, remote_id, channel_id, views, avg_view_pct, avg_view_sec, est_minutes, subs_gained) VALUES (?,?,?,?,?,?,?,?)', 'youtube_shorts', u.remote_id, ch.id, x.views, x.avgViewPct, x.avgViewSec, x.estMinutes, x.subsGained); res.recorded++;
      } catch (e) { res.errors.push(`${ch.slug}/${u.remote_id}: ${(e as Error).message.slice(0, 100)}`); if (/^(AUTH_|QUOTA_)/.test((e as Error).message)) break; }
    }
  }
  return res;
}

/** What actually held viewers: mean avg-view-% by clip category for one channel (latest retention row per video). Needs >= minSamples videos. */
export function learnedCategoryPrior(store: Store, channelId: number, minSamples = 5): Record<string, number> {
  const rows = store.all<{ category: string; pct: number }>(`SELECT cd.category AS category, r.avg_view_pct AS pct FROM retention r JOIN (SELECT remote_id, max(id) mid FROM retention GROUP BY remote_id) m ON m.mid=r.id JOIN uploads u ON u.remote_id=r.remote_id AND u.platform='youtube_shorts' JOIN clips c ON c.id=u.clip_id JOIN candidates cd ON cd.id=c.candidate_id WHERE r.channel_id=? AND r.avg_view_pct IS NOT NULL`, channelId);
  if (rows.length < minSamples) return {};
  const all = rows.reduce((a, r) => a + r.pct, 0) / rows.length; if (!(all > 0)) return {};
  const by = new Map<string, number[]>(); for (const r of rows) by.set(r.category, [...(by.get(r.category) ?? []), r.pct]);
  const out: Record<string, number> = {}; for (const [k, v] of by) if (v.length >= 2) out[k] = +Math.max(0.9, Math.min(1.15, 1 + 0.3 * (v.reduce((a, b) => a + b, 0) / v.length / all - 1))).toFixed(3);
  return out;
}

export const TOKEN_PLATFORMS = ['instagram', 'facebook', 'tiktok'] as const;
export function analyticsProviders(store: Store, cfg: Config): Provider[] {
  const secrets = secretsFor(cfg);
  const yt = listChannels(store).map((ch) => { const tp = tokenFor(cfg, ch); const p = youtubeProvider(new YouTubeAdapter(store, tp), () => tp.connected()); return { ...p, platform: p.platform, channelId: ch.id, connected: () => tp.connected(), fetch: (ids: string[]) => p.fetch(ids) } as Provider; });
  return [...yt, instagramProvider(secrets), facebookProvider(secrets), tiktokProvider(secrets, () => tiktokAccessToken(cfg))];
}
/** Owner supplies a platform access token (stored encrypted if YT_CLIPS_SECRET_KEY is set). Never echoed back. */
export function saveTokenFor(cfg: Config, platform: string, accessToken: string): void {
  if (!(TOKEN_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`invalid: platform must be one of ${TOKEN_PLATFORMS.join(', ')}`);
  if (accessToken.length < 10 || accessToken.length > 4096) throw new Error('invalid: access token length');
  secretsFor(cfg).write(platform, { access_token: accessToken });
}
export function platformStatus(store: Store, cfg: Config) { const m = new Map<string, boolean>(); for (const p of analyticsProviders(store, cfg)) m.set(p.platform, (m.get(p.platform) ?? false) || p.connected()); return [...m].map(([platform, analyticsConnected]) => ({ platform, analyticsConnected })); }

export interface TickResult { queued: number; advanced: number; published: number; blocked: Record<string, number>; errors: string[] }
/**
 * One automation cycle (called by the worker loop). Does nothing unless the OWNER set automation.autoQueue in data/config.json.
 * Queues QC-passed clips that have metadata, then advances each pending upload by steps until it blocks. Every step still passes
 * assertPublishAllowed (gates), so with gates off nothing touches a platform. Scheduling uses measured hours when enough evidence exists.
 */
export async function automationTick(store: Store, cfg: Config, now = new Date()): Promise<TickResult> {
  const r: TickResult = { queued: 0, advanced: 0, published: 0, blocked: {}, errors: [] };
  if (!cfg.automation.autoQueue) return r;
  for (const ch of listChannels(store)) for (const platform of (ch.config.platforms?.length ? ch.config.platforms : cfg.automation.platforms)) {
    if (!cfg.automation.platforms.includes(platform)) continue; // the global list is the owner's master switch
    const fresh = store.all<{ id: number }>(`SELECT c.id FROM clips c JOIN candidates k ON k.id=c.candidate_id JOIN videos v ON v.id=k.video_id LEFT JOIN sources s ON s.id=v.source_id WHERE COALESCE(s.channel_id, ?)=? AND c.qc_pass=1 AND c.metadata_json IS NOT NULL AND c.edited_path IS NOT NULL AND c.review<>'rejected' AND (?=0 OR c.review='approved') AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.clip_id=c.id AND u.platform=?) ORDER BY c.id LIMIT ?`, mainChannel(store).id, ch.id, cfg.automation.requireReview ? 1 : 0, platform, cfg.automation.maxAdvancePerCycle);
    for (const c of fresh) { queueUpload(store, c.id, platform); r.queued++; }
  }
  const pending = store.all<{ id: number; platform: string; state: string }>(`SELECT id, platform, state FROM uploads WHERE state NOT IN ('PUBLISHED','QC_FAILED','FAILED','ANALYTICS_WAIT','ANALYZING','LEARNING','NEXT_CYCLE') AND platform IN (${cfg.automation.platforms.map(() => '?').join(',') || "''"}) ORDER BY id LIMIT ?`, ...cfg.automation.platforms, cfg.automation.maxAdvancePerCycle);
  for (const u of pending) {
    for (let step = 0; step < 8; step++) {
      try {
        const cur = store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', u.id)!.state; let at: Date | null = null;
        if (cur === 'UNLISTED_VERIFIED' && !cfg.automation.autoApprove) { r.blocked.NEEDS_APPROVAL = (r.blocked.NEEDS_APPROVAL ?? 0) + 1; break; }
        if (cur === 'UNLISTED_VERIFIED') { const ch = channelByUpload(store, u.id); at = planFromStore(store, { n: 1, tz: cfg.timezone, cfg: scheduleFor(cfg, ch), from: now, platform: u.platform, channelId: ch.id }).slots[0]?.at ?? null; if (!at) { r.blocked.NO_SLOT = (r.blocked.NO_SLOT ?? 0) + 1; break; } }
        const res = await advance(store, cfg, u.id, at ? { scheduledAt: at } : {});
        if ('blocked' in res) { const k = /^[A-Z_]+/.exec(res.blocked)?.[0] ?? 'BLOCKED'; if (k === 'MANUAL_POST_REQUIRED') void notify(store, cfg, `manual:${u.id}`, `Post this clip now on ${u.platform} (task #${u.id}). Dashboard → Publish → Manual post tasks.`); r.blocked[k] = (r.blocked[k] ?? 0) + 1; break; }
        r.advanced++; if (res.state === 'PUBLISHED') { r.published++; void notify(store, cfg, `pub:${u.id}`, `Published on ${u.platform} (upload #${u.id}).`); break; } if (res.state === 'QC_FAILED' || res.state === 'FAILED') break;
      } catch (e) { r.errors.push(`upload ${u.id}: ${(e as Error).message.slice(0, 160)}`); break; }
    }
  }
  return r;
}

/** Read new top-level comments on our PUBLISHED YouTube videos into the comments table (classified, draft replies; nothing is posted). */
export async function collectYoutubeComments(store: Store, cfg: Config): Promise<{ videos: number; newComments: number; error?: string }> {
  let videos = 0, n = 0; let error: string | undefined;
  for (const ch of listChannels(store)) {
    const tp = tokenFor(cfg, ch); if (!tp.connected()) continue;
    const ups = store.all<{ remote_id: string }>(`SELECT remote_id FROM uploads WHERE platform='youtube_shorts' AND COALESCE(channel_id, ?)=? AND remote_id IS NOT NULL AND state IN ('PUBLISHED','ANALYTICS_WAIT','ANALYZING','LEARNING','NEXT_CYCLE')`, mainChannel(store).id, ch.id);
    if (!ups.length) continue;
    const ad = new YouTubeAdapter(store, tp); videos += ups.length;
    try {
      const key = ch.slug === 'main' ? 'yt_channel_id' : `yt_channel_id:${ch.slug}`;
      let own = store.get<{ v: string }>(`SELECT v FROM kv WHERE k=?`, key)?.v ?? null;
      if (!own) { own = (await ad.whoami())?.id ?? null; if (own) store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, key, own); }
      for (const u of ups) for (const c of await ad.listComments(u.remote_id, own)) { if (!ingestComment(store, 'youtube_shorts', c.id, c.text).duplicate) n++; }
    } catch (e) { error = `${ch.slug}: ${(e as Error).message.slice(0, 160)}`; }
  }
  return error ? { videos, newComments: n, error } : { videos, newComments: n };
}

/** Post ONE approved reply. Needs: gates.commentsAutoPost (owner), per-comment approval, the force-ssl scope, daily cap. */
export async function postComment(store: Store, cfg: Config, commentId: number): Promise<void> {
  await postApprovedReply(store, cfg, commentId, async (platform, remoteId, text) => {
    if (platform !== 'youtube_shorts') throw new Error(`AUTH_NOT_CONNECTED: no comment poster for ${platform}`);
    const up = store.get<{ channel_id: number | null }>('SELECT channel_id FROM uploads WHERE remote_id=? AND platform=?', remoteId, platform);
    const ch = (up?.channel_id ? getChannel(store, up.channel_id) : null) ?? mainChannel(store);
    const sc = connectedScope(secretsFor(cfg), ytSecretName(ch)); if (!sc) throw new Error('AUTH_NOT_CONNECTED: connect YouTube first');
    if (!sc.split(/\s+/).includes(YT_FORCE_SSL_SCOPE)) throw new Error('AUTH_SCOPE: comment replies need the youtube.force-ssl scope. Run `npm run cli -- youtube-connect-full` once.');
    await new YouTubeAdapter(store, tokenFor(cfg, ch)).replyToComment(remoteId, text);
  });
}

/** Account optimizer: generate (and optionally apply to YouTube) the channel's profile kit. Applying is an explicit owner action; it only touches description/keywords and playlists that do not exist yet. */
export async function optimizeAccount(store: Store, cfg: Config, ch: Channel, o: { apply?: boolean; playlists?: boolean } = {}): Promise<{ kit: AccountKit; applied: string[]; note?: string }> {
  const tp = tokenFor(cfg, ch); const ad = new YouTubeAdapter(store, tp); const applied: string[] = []; let note: string | undefined; let yt: { description: string; keywords: string } | null = null;
  if (tp.connected()) { try { yt = await ad.getBranding(); } catch (e) { note = `YouTube profile read failed: ${(e as Error).message.slice(0, 100)}`; } } else note = 'YouTube connect nahi hai: kit ban gaya, apply ke liye pehle connect karo';
  const kit = buildAccountKit(store, ch, { youtube: yt });
  if (o.apply) {
    if (!tp.connected()) throw new Error('AUTH_NOT_CONNECTED: pehle is channel ka YouTube connect karo');
    await ad.setBranding({ description: kit.description, keywords: kit.keywords }); applied.push('description', 'keywords');
    if (o.playlists) { const have = new Set((await ad.listPlaylists()).map((t) => t.toLowerCase())); for (const p of kit.playlists) if (!have.has(p.title.toLowerCase())) { await ad.createPlaylist(p.title, p.description); applied.push(`playlist: ${p.title}`); } }
  }
  store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `account:kit:${ch.slug}`, JSON.stringify({ kit, applied, at: new Date().toISOString() }));
  return { kit, applied, note };
}
export function storedAccountKit(store: Store, slug: string): { kit: AccountKit; applied: string[]; at: string } | null { const r = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `account:kit:${slug}`)?.v; return r ? JSON.parse(r) : null; }
