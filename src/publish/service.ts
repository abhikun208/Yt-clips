import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { advanceUpload, queueUpload, DryRunAdapter, type Adapter, type ClipFacts, type UploadState } from './machine.ts';
import { SecretStore } from './secrets.ts';
import { TokenProvider, clientCreds, startDeviceFlow, pollDeviceFlow, type DeviceStart } from './oauth.ts';
import { YouTubeAdapter } from './youtube.ts';
import { instagramProvider, facebookProvider, tiktokProvider, youtubeProvider, type Provider } from '../analytics/providers.ts';
import { probe } from '../media/probe.ts';

export const secretsFor = (cfg: Config) => new SecretStore(join(cfg.dataDir, 'secrets'));

/** Real facts about a rendered clip: dimensions/duration are PROBED from the edited file, metadata from the stored SEO step. Never invents values. */
export async function factsForClip(store: Store, clipId: number): Promise<ClipFacts> {
  const c = store.get<{ metadata_json: string | null; qc_pass: number | null; thumbnail_path: string | null; candidate_id: number; edited_path: string | null }>('SELECT metadata_json, qc_pass, thumbnail_path, candidate_id, edited_path FROM clips WHERE id=?', clipId);
  if (!c) throw new Error(`Unknown clip ${clipId}`);
  if (!c.metadata_json) throw new Error('NOT_READY: metadata not generated yet for this clip');
  if (!c.edited_path) throw new Error('NOT_READY: clip not rendered yet');
  const md = JSON.parse(c.metadata_json) as { title: string; description: string; tags?: string[]; language?: string };
  const m = await probe(c.edited_path);
  const src = store.get<{ authorized: number | null }>('SELECT s.authorized FROM candidates c JOIN videos v ON v.id=c.video_id LEFT JOIN sources s ON s.id=v.source_id WHERE c.id=?', c.candidate_id);
  return { width: m.width, height: m.height, duration: m.duration, title: md.title, description: md.description, tags: md.tags ?? [], language: md.language, qcPass: !!c.qc_pass, authorized: src?.authorized == null ? true : src.authorized === 1, thumbnailPath: c.thumbnail_path };
}

export function adapterFor(store: Store, cfg: Config, platform: string): Adapter {
  if (platform === 'dryrun') return new DryRunAdapter();
  if (platform === 'youtube_shorts' || platform === 'youtube') return new YouTubeAdapter(store, new TokenProvider(secretsFor(cfg)));
  throw new Error(`AUTH_NOT_CONNECTED: no adapter for platform "${platform}" (only youtube_shorts has a real adapter; others need owner credentials)`);
}

export function listUploads(store: Store) {
  return store.all(`SELECT u.id, u.clip_id, u.platform, u.state, u.remote_id, u.visibility, u.scheduled_at, u.error, u.updated_at, c.output_id FROM uploads u JOIN clips c ON c.id=u.clip_id ORDER BY u.id DESC LIMIT 200`);
}

export async function advance(store: Store, cfg: Config, uploadId: number, o: { approve?: boolean; scheduledAt?: Date | null } = {}): Promise<{ state: UploadState } | { state: string; blocked: string }> {
  const u = store.get<{ clip_id: number; platform: string; state: string }>('SELECT clip_id, platform, state FROM uploads WHERE id=?', uploadId);
  if (!u) throw new Error(`Unknown upload ${uploadId}`);
  const facts = await factsForClip(store, u.clip_id);
  try { return { state: await advanceUpload(store, cfg, adapterFor(store, cfg, u.platform), uploadId, { facts, ...o }) }; }
  catch (e) { const m = (e as Error).message; if (/^(PUBLISH_DISABLED|PUBLIC_DISABLED|NEEDS_APPROVAL|NOT_READY|QUOTA_EXCEEDED|AUTH_)/.test(m)) return { state: store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', uploadId)!.state, blocked: m }; throw e; }
}

export { queueUpload };

export function youtubeStatus(store: Store, cfg: Config) {
  const secrets = secretsFor(cfg); const tp = new TokenProvider(secrets); const ad = new YouTubeAdapter(store, tp);
  return { clientConfigured: !!clientCreds(secrets), connected: tp.connected(), secretsEncrypted: secrets.encrypted, quota: { insertsUsed: ad.quotaUsed('insert'), unitsUsed: ad.quotaUsed('units') }, gates: { publishEnabled: cfg.gates.publishEnabled, publicVisibilityAllowed: cfg.gates.publicVisibilityAllowed } };
}
export async function youtubeConnectStart(store: Store, cfg: Config): Promise<DeviceStart> {
  const cc = clientCreds(secretsFor(cfg)); if (!cc) throw new Error('invalid: set YT_OAUTH_CLIENT_ID and YT_OAUTH_CLIENT_SECRET (Google Cloud "TVs and Limited Input devices" OAuth client) first');
  const d = await startDeviceFlow(cc.clientId); store.exec(`INSERT INTO kv(k,v) VALUES('yt_device_code',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')`, d.device_code); return d;
}
export async function youtubeConnectPoll(store: Store, cfg: Config) {
  const cc = clientCreds(secretsFor(cfg)); if (!cc) throw new Error('invalid: OAuth client not configured');
  const row = store.get<{ v: string }>(`SELECT v FROM kv WHERE k='yt_device_code'`); if (!row) throw new Error('invalid: start the connect flow first');
  const r = await pollDeviceFlow(secretsFor(cfg), cc.clientId, cc.clientSecret, row.v);
  if (r.status === 'ok') store.exec(`DELETE FROM kv WHERE k='yt_device_code'`);
  return { status: r.status };
}

export const TOKEN_PLATFORMS = ['instagram', 'facebook', 'tiktok'] as const;
export function analyticsProviders(store: Store, cfg: Config): Provider[] {
  const secrets = secretsFor(cfg); const tp = new TokenProvider(secrets);
  return [youtubeProvider(new YouTubeAdapter(store, tp), () => tp.connected()), instagramProvider(secrets), facebookProvider(secrets), tiktokProvider(secrets)];
}
/** Owner supplies a platform access token (stored encrypted if YT_CLIPS_SECRET_KEY is set). Never echoed back. */
export function saveTokenFor(cfg: Config, platform: string, accessToken: string): void {
  if (!(TOKEN_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`invalid: platform must be one of ${TOKEN_PLATFORMS.join(', ')}`);
  if (accessToken.length < 10 || accessToken.length > 4096) throw new Error('invalid: access token length');
  secretsFor(cfg).write(platform, { access_token: accessToken });
}
export function platformStatus(store: Store, cfg: Config) { return analyticsProviders(store, cfg).map((p) => ({ platform: p.platform, analyticsConnected: p.connected() })); }
