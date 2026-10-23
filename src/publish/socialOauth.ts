import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { SecretStore } from './secrets.ts';

/**
 * Login (OAuth authorization-code) for Facebook+Instagram (one Meta app) and TikTok. The owner registers their OWN developer app
 * (free) and pastes its id/secret; tokens are stored in data/secrets (encrypted when YT_CLIPS_SECRET_KEY is set) and are what the analytics providers read.
 * Endpoints: Facebook manual login flow + code exchange (Meta docs, fetched 2026-10-23); long-lived exchange and /me/accounts as documented by Meta;
 * TikTok authorize/token/refresh (TikTok docs, token endpoints fetched 2026-10-23). Tested against fake servers only.
 */
const FB_VER = 'v26.0';
const fbDialog = () => process.env.FB_DIALOG_BASE ?? `https://www.facebook.com/${FB_VER}/dialog/oauth`;
const graph = () => process.env.GRAPH_API_BASE ?? `https://graph.facebook.com/${FB_VER}`;
const ttAuth = () => process.env.TIKTOK_AUTH_BASE ?? 'https://www.tiktok.com/v2/auth/authorize/';
const ttApi = () => process.env.TIKTOK_API_BASE ?? 'https://open.tiktokapis.com';
export const FB_SCOPES = 'pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights';
export const TT_SCOPES = 'user.info.basic,video.list';
export type SocialApp = 'facebook' | 'tiktok';

const secretsOf = (cfg: Config) => new SecretStore(join(cfg.dataDir, 'secrets'));
export function appCreds(cfg: Config, app: SocialApp): { id: string; secret: string } | null {
  const E = process.env; const id = app === 'facebook' ? E.FB_APP_ID : E.TIKTOK_CLIENT_KEY; const sec = app === 'facebook' ? E.FB_APP_SECRET : E.TIKTOK_CLIENT_SECRET;
  if (id && sec) return { id, secret: sec };
  let r: { id?: string; secret?: string } | null = null; try { r = secretsOf(cfg).read(`oauth-app-${app}`); } catch { r = null; }
  return r?.id && r.secret ? { id: r.id, secret: r.secret } : null;
}
export function saveAppCreds(cfg: Config, app: string, id: string, secret: string): void {
  if (app !== 'facebook' && app !== 'tiktok' && app !== 'google') throw new Error('invalid: app must be google, facebook or tiktok');
  if (app === 'google') { if (id.length < 10 || id.length > 200 || secret.length < 8 || secret.length > 200) throw new Error('invalid: id/secret format'); secretsOf(cfg).write('youtube-client', { client_id: id, client_secret: secret }); return; }
  if (!/^[\w-]{4,80}$/.test(id) || secret.length < 8 || secret.length > 200) throw new Error('invalid: id/secret format');
  secretsOf(cfg).write(`oauth-app-${app}`, { id, secret });
}
export const redirectUri = (base: string, app: SocialApp) => `${base.replace(/\/+$/, '')}/api/oauth/${app}/callback`;

export function startAuth(store: Store, cfg: Config, app: SocialApp, base: string): string {
  const c = appCreds(cfg, app); if (!c) throw new Error(`invalid: save the ${app === 'facebook' ? 'Meta (Facebook) app id/secret' : 'TikTok client key/secret'} first`);
  const state = randomBytes(18).toString('hex'); store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, `oauth_state_${state}`, JSON.stringify({ app, at: Date.now() }));
  const ru = redirectUri(base, app);
  if (app === 'facebook') return `${fbDialog()}?${new URLSearchParams({ client_id: c.id, redirect_uri: ru, state, scope: FB_SCOPES, response_type: 'code' })}`;
  return `${ttAuth()}?${new URLSearchParams({ client_key: c.id, scope: TT_SCOPES, response_type: 'code', redirect_uri: ru, state })}`;
}
function takeState(store: Store, state: string, app: SocialApp): void {
  const row = store.get<{ v: string }>(`SELECT v FROM kv WHERE k=?`, `oauth_state_${state}`); store.exec(`DELETE FROM kv WHERE k=?`, `oauth_state_${state}`);
  const j = row ? JSON.parse(row.v) as { app: string; at: number } : null;
  if (!j || j.app !== app || Date.now() - j.at > 10 * 60_000) throw new Error('invalid: unknown or expired login state, start again');
}
async function getJ(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); const j = await r.json().catch(() => ({})); if (!r.ok || j?.error) throw new Error(`oauth: ${(j?.error?.message ?? j?.error_description ?? j?.error ?? r.status)}`.toString().slice(0, 200)); return j;
}

export async function handleCallback(store: Store, cfg: Config, app: SocialApp, q: { code?: string | null; state?: string | null; error?: string | null }, base: string): Promise<{ connected: string[]; note?: string }> {
  if (q.error) throw new Error(`oauth: ${q.error}`.slice(0, 100)); if (!q.code || !q.state) throw new Error('invalid: missing code/state');
  takeState(store, q.state, app); const c = appCreds(cfg, app)!; const sec = secretsOf(cfg); const ru = redirectUri(base, app);
  if (app === 'tiktok') {
    const j = await getJ(`${ttApi()}/v2/oauth/token/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: c.id, client_secret: c.secret, code: q.code, grant_type: 'authorization_code', redirect_uri: ru }) });
    if (!j.access_token) throw new Error('oauth: no access_token from TikTok');
    sec.write('tiktok', { access_token: j.access_token, refresh_token: j.refresh_token, open_id: j.open_id, expires_at: Date.now() + (Number(j.expires_in) || 86400) * 1000, refresh_expires_at: Date.now() + (Number(j.refresh_expires_in) || 31536000) * 1000 });
    return { connected: ['tiktok'] };
  }
  const t1 = await getJ(`${graph()}/oauth/access_token?${new URLSearchParams({ client_id: c.id, redirect_uri: ru, client_secret: c.secret, code: q.code })}`);
  let user = String(t1.access_token ?? ''); if (!user) throw new Error('oauth: no access_token from Facebook');
  try { const t2 = await getJ(`${graph()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: c.id, client_secret: c.secret, fb_exchange_token: user })}`); if (t2.access_token) user = t2.access_token; } catch { /* keep short-lived token; analytics still works until it expires */ }
  const pages = await getJ(`${graph()}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account', access_token: user })}`);
  const list = (pages.data ?? []) as { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }[];
  if (!list.length) throw new Error('oauth: no Facebook Page found for this login (Page admin access is needed for Facebook/Instagram insights)');
  const pg = list.find((p) => p.instagram_business_account) ?? list[0]!; const connected = ['facebook'];
  sec.write('facebook', { access_token: pg.access_token, page_id: pg.id, page_name: pg.name, connected_at: new Date().toISOString() });
  if (pg.instagram_business_account) { sec.write('instagram', { access_token: user, ig_user_id: pg.instagram_business_account.id, connected_at: new Date().toISOString() }); connected.push('instagram'); }
  return { connected, note: pg.instagram_business_account ? undefined : `Page "${pg.name}" has no linked Instagram professional account` };
}

/** Valid TikTok access token: refreshes with the refresh token when expired (access tokens last 24h per TikTok docs). */
export async function tiktokAccessToken(cfg: Config): Promise<string | null> {
  const sec = secretsOf(cfg); const t = sec.read<{ access_token?: string; refresh_token?: string; expires_at?: number }>('tiktok'); if (!t?.access_token) return null;
  if (!t.expires_at || t.expires_at > Date.now() + 120_000) return t.access_token;
  const c = appCreds(cfg, 'tiktok'); if (!c || !t.refresh_token) throw new Error('AUTH_REVOKED: TikTok token expired and cannot be refreshed (log in again)');
  const j = await getJ(`${ttApi()}/v2/oauth/token/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: c.id, client_secret: c.secret, grant_type: 'refresh_token', refresh_token: t.refresh_token }) }).catch(() => { throw new Error('AUTH_REVOKED: TikTok refresh failed (log in again)'); });
  if (!j.access_token) throw new Error('AUTH_REVOKED: TikTok refresh failed (log in again)');
  sec.write('tiktok', { ...t, access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 86400) * 1000 });
  return j.access_token;
}
