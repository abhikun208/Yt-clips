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
/** Added only when the owner asks for upload access (Publish tab): the Meta app must have these permissions enabled or the dialog refuses. */
export const FB_PUBLISH_SCOPES = ',pages_manage_posts,instagram_content_publish';
export const TT_SCOPES = 'user.info.basic,video.list';
export type SocialApp = 'facebook' | 'tiktok';

const secretsOf = (cfg: Config) => SecretStore.forData(cfg.dataDir);
export function appCreds(cfg: Config, app: SocialApp): { id: string; secret: string } | null {
  const E = process.env; const id = app === 'facebook' ? E.FB_APP_ID : E.TIKTOK_CLIENT_KEY; const sec = app === 'facebook' ? E.FB_APP_SECRET : E.TIKTOK_CLIENT_SECRET;
  if (id && sec) return { id, secret: sec };
  let r: { id?: string; secret?: string } | null = null; try { r = secretsOf(cfg).read(`oauth-app-${app}`); } catch { r = null; }
  return r?.id && r.secret ? { id: r.id, secret: r.secret } : null;
}
export function saveAppCreds(cfg: Config, app: string, id: string, secret: string): void {
  id = id.replace(/\s+/g, ''); secret = secret.replace(/\s+/g, ''); // copy-paste from a phone often drags a space/newline along
  if (app !== 'facebook' && app !== 'tiktok' && app !== 'google') throw new Error('invalid: app must be google, facebook or tiktok');
  if (app === 'google') { if (id.length < 10 || id.length > 200 || secret.length < 8 || secret.length > 200) throw new Error('invalid: id/secret format'); secretsOf(cfg).write('youtube-client', { client_id: id, client_secret: secret }); return; }
  if (!/^[\w-]{4,80}$/.test(id) || secret.length < 8 || secret.length > 200) throw new Error('invalid: id/secret format');
  secretsOf(cfg).write(`oauth-app-${app}`, { id, secret });
}
/** Permanent https redirect: a static page (docs/oauth-relay.html on GitHub Pages) that bounces the login result to the server on 127.0.0.1. No tunnel, nothing to re-register. */
export const DEFAULT_RELAY = 'https://abhikun208.github.io/Yt-clips/oauth-relay.html';
let relay: string | null = null;
export const setRelay = (v: string | null): void => { try { const u = v ? new URL(v) : null; relay = u && u.protocol === 'https:' ? u.origin + u.pathname : null; } catch { relay = null; } };
export const getRelay = (): string | null => relay;
export const redirectUri = (base: string, app: SocialApp) => relay ?? `${base.replace(/\/+$/, '')}/api/oauth/${app}/callback`;

export function startAuth(store: Store, cfg: Config, app: SocialApp, base: string, o: { publish?: boolean; port?: number } = {}): string {
  const c = appCreds(cfg, app); if (!c) throw new Error(`invalid: save the ${app === 'facebook' ? 'Meta (Facebook) app id/secret' : 'TikTok client key/secret'} first`);
  const state = (relay ? `${app}.${o.port ?? 8080}.` : '') + randomBytes(18).toString('hex'); store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, `oauth_state_${state}`, JSON.stringify({ app, at: Date.now(), ru: redirectUri(base, app) }));
  const ru = redirectUri(base, app);
  if (app === 'facebook') return `${fbDialog()}?${new URLSearchParams({ client_id: c.id, redirect_uri: ru, state, scope: FB_SCOPES + (o.publish ? FB_PUBLISH_SCOPES : ''), response_type: 'code' })}`;
  return `${ttAuth()}?${new URLSearchParams({ client_key: c.id, scope: TT_SCOPES, response_type: 'code', redirect_uri: ru, state })}`;
}
function takeState(store: Store, state: string, app: SocialApp): void {
  const row = store.get<{ v: string }>(`SELECT v FROM kv WHERE k=?`, `oauth_state_${state}`); store.exec(`DELETE FROM kv WHERE k=?`, `oauth_state_${state}`);
  const j = row ? JSON.parse(row.v) as { app: string; at: number } : null;
  if (!j || j.app !== app || Date.now() - j.at > 10 * 60_000) throw new Error('invalid: unknown or expired login state, start again');
}
/** fetch with 3 tries and a readable network reason ("fetch failed" alone hides ENOTFOUND/ETIMEDOUT/EAI_AGAIN). */
export async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 700 * (i + 1))); }
  }
  const c = (last as { cause?: { code?: string; message?: string } })?.cause; const host = (() => { try { return new URL(url).host; } catch { return url.slice(0, 40); } })();
  throw new Error(`network: ${host} tak nahi pahunch paya (${c?.code ?? c?.message ?? (last as Error)?.message ?? 'unknown'})`);
}
async function getJ(url: string, init?: RequestInit): Promise<any> {
  const r = await netFetch(url, init); const j = await r.json().catch(() => ({})); if (!r.ok || j?.error) throw new Error(`oauth: ${(j?.error?.message ?? j?.error_description ?? j?.error ?? r.status)}`.toString().slice(0, 200)); return j;
}

/**
 * Checks the saved Meta App ID + App secret WITHOUT a login (Meta's client_credentials call). Only an explicit credential error from Meta counts as "bad";
 * network trouble or an unexpected answer is "unknown" and never blocks the login. Returns the app's name when Meta gives it, so the owner can see WHICH app the ID belongs to.
 * The secret is only sent to Meta and never returned or logged.
 */
export async function checkAppCreds(cfg: Config, app: SocialApp): Promise<{ status: 'ok' | 'bad' | 'unknown'; appName?: string; message?: string }> {
  if (app !== 'facebook') return { status: 'unknown', message: 'TikTok keys can only be checked by a real login' };
  const c = appCreds(cfg, 'facebook'); if (!c) return { status: 'unknown', message: 'no app saved' };
  try {
    const r = await netFetch(`${graph()}/oauth/access_token?${new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: 'client_credentials' })}`); const j = await r.json().catch(() => ({})) as { access_token?: string; error?: { message?: string } };
    if (j.access_token) { let appName: string | undefined; try { const n = await netFetch(`${graph()}/${encodeURIComponent(c.id)}?${new URLSearchParams({ fields: 'name', access_token: j.access_token })}`); appName = ((await n.json()) as { name?: string }).name; } catch { /* name is only a nicety */ } return { status: 'ok', ...(appName ? { appName } : {}) }; }
    const m = String(j.error?.message ?? ''); if (/client secret|validating application|Invalid application|Invalid client|app id|secret/i.test(m)) return { status: 'bad', message: m.slice(0, 160) };
    return { status: 'unknown', message: m.slice(0, 120) || `HTTP ${r.status}` };
  } catch (e) { return { status: 'unknown', message: (e as Error).message.slice(0, 120) }; }
}

interface MetaPage { id: string; name: string; access_token: string; ig_user_id: string | null; ut?: string }
export async function handleCallback(store: Store, cfg: Config, app: SocialApp, q: { code?: string | null; state?: string | null; error?: string | null }, base: string): Promise<{ connected: string[]; note?: string }> {
  if (q.error) throw new Error(`oauth: ${q.error}`.slice(0, 100)); if (!q.code || !q.state) throw new Error('invalid: missing code/state');
  takeState(store, q.state, app); const c = appCreds(cfg, app)!; const sec = secretsOf(cfg); const ru = redirectUri(base, app);
  if (app === 'tiktok') {
    const j = await getJ(`${ttApi()}/v2/oauth/token/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: c.id, client_secret: c.secret, code: q.code, grant_type: 'authorization_code', redirect_uri: ru }) });
    if (!j.access_token) throw new Error('oauth: no access_token from TikTok');
    const rec = { access_token: j.access_token, refresh_token: j.refresh_token, open_id: j.open_id, expires_at: Date.now() + (Number(j.expires_in) || 86400) * 1000, refresh_expires_at: Date.now() + (Number(j.refresh_expires_in) || 31536000) * 1000 };
    // each TikTok account keeps its own secret (tiktok-<open_id>); the default `tiktok` is only set when empty or when it is the same account (reconnect)
    const cur = (() => { try { return sec.read<{ open_id?: string; access_token?: string }>('tiktok'); } catch { return null; } })(); const oid = String(j.open_id ?? '').replace(/[^\w-]/g, '').slice(0, 64);
    if (!cur?.access_token || cur.open_id === j.open_id || !oid) sec.write('tiktok', rec); else sec.write(`tiktok-${oid}`, rec);
    return { connected: ['tiktok'], note: cur?.access_token && cur.open_id && cur.open_id !== j.open_id ? 'Naya TikTok account alag se jud gaya; pehla account jaisa tha waisa hi hai' : undefined };
  }
  const t1 = await getJ(`${graph()}/oauth/access_token?${new URLSearchParams({ client_id: c.id, redirect_uri: ru, client_secret: c.secret, code: q.code })}`);
  let user = String(t1.access_token ?? ''); if (!user) throw new Error('oauth: no access_token from Facebook');
  try { const t2 = await getJ(`${graph()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: c.id, client_secret: c.secret, fb_exchange_token: user })}`); if (t2.access_token) user = t2.access_token; } catch { /* keep short-lived token; analytics still works until it expires */ }
  const pages = await getJ(`${graph()}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account', access_token: user })}`);
  const list = (pages.data ?? []) as { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }[];
  if (!list.length) throw new Error('oauth: no Facebook Page found for this login (Page admin access is needed for Facebook/Instagram insights)');
  let perms: string[] = []; try { const pm = await getJ(`${graph()}/me/permissions?${new URLSearchParams({ access_token: user })}`); perms = ((pm.data ?? []) as { permission: string; status: string }[]).filter((x) => x.status === 'granted').map((x) => x.permission); } catch { /* publishing just stays manual */ }
  const pg = list.find((p) => p.instagram_business_account) ?? list[0]!; const connected = ['facebook'];
  // MERGE, never replace: a second Meta login (another person / another Page set) adds its Pages; Pages seen before stay, refreshed when returned again.
  const prev = (() => { try { return sec.read<{ pages?: MetaPage[] }>('meta-pages'); } catch { return null; } })();
  const fresh: MetaPage[] = list.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token, ig_user_id: p.instagram_business_account?.id ?? null, ut: user }));
  const keep = (prev?.pages ?? []).filter((o) => !fresh.some((n) => n.id === o.id));
  sec.write('meta-pages', { pages: [...keep, ...fresh], user_token: user, perms, connected_at: new Date().toISOString() });
  // the default Facebook/Instagram account is only set when none exists, or refreshed when this login returns that same Page; another account is never overwritten
  const curF = (() => { try { return sec.read<{ page_id?: string; access_token?: string }>('facebook'); } catch { return null; } })();
  const curI = (() => { try { return sec.read<{ ig_user_id?: string; access_token?: string }>('instagram'); } catch { return null; } })();
  const refreshF = !curF?.access_token || list.some((p) => p.id === curF.page_id); const fp = (curF?.access_token && list.find((p) => p.id === curF.page_id)) || pg;
  if (refreshF) sec.write('facebook', { access_token: fp.access_token, page_id: fp.id, page_name: fp.name, perms, connected_at: new Date().toISOString() });
  const ig = (refreshF ? fp : null)?.instagram_business_account ?? (!curI?.access_token ? pg.instagram_business_account : undefined);
  if (ig && (!curI?.access_token || curI.ig_user_id === ig.id || refreshF)) { const owner = list.find((p) => p.instagram_business_account?.id === ig.id) ?? pg; sec.write('instagram', { access_token: user, page_token: owner.access_token, ig_user_id: ig.id, perms, connected_at: new Date().toISOString() }); connected.push('instagram'); }
  return { connected, note: ig ? undefined : `Page "${pg.name}" has no linked Instagram professional account` };
}

/** Valid TikTok access token: refreshes with the refresh token when expired (access tokens last 24h per TikTok docs). */
export async function tiktokAccessToken(cfg: Config, force = false): Promise<string | null> {
  const sec = secretsOf(cfg); const t = sec.read<{ access_token?: string; refresh_token?: string; expires_at?: number }>('tiktok'); if (!t?.access_token) return null;
  if (!force && (!t.expires_at || t.expires_at > Date.now() + 120_000)) return t.access_token;
  const c = appCreds(cfg, 'tiktok'); if (!c || !t.refresh_token) throw new Error('AUTH_REVOKED: TikTok token expired and cannot be refreshed (log in again)');
  const j = await getJ(`${ttApi()}/v2/oauth/token/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: c.id, client_secret: c.secret, grant_type: 'refresh_token', refresh_token: t.refresh_token }) }).catch(() => { throw new Error('AUTH_REVOKED: TikTok refresh failed (log in again)'); });
  if (!j.access_token) throw new Error('AUTH_REVOKED: TikTok refresh failed (log in again)');
  sec.write('tiktok', { ...t, access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 86400) * 1000 });
  return j.access_token;
}

/** Is the saved Facebook/Instagram token still accepted by Meta? (cheap GET /me; error code 190 = expired/revoked/password changed) */
export async function metaTokenStatus(cfg: Config): Promise<{ name: string; ok: boolean; error?: string }[]> {
  const sec = secretsOf(cfg); const out: { name: string; ok: boolean; error?: string }[] = [];
  for (const name of ['facebook', 'instagram']) {
    let t: { access_token?: string; page_token?: string } | null = null; try { t = sec.read(name); } catch { t = null; } const tok = t?.page_token ?? t?.access_token; if (!tok) continue;
    try { const r = await fetch(`${graph()}/me?${new URLSearchParams({ fields: 'id', access_token: tok })}`, { signal: AbortSignal.timeout(15_000) }); const j = await r.json().catch(() => ({})) as { error?: { code?: number; message?: string } };
      out.push(j.error ? { name, ok: false, error: `code ${j.error.code}: ${String(j.error.message ?? '').slice(0, 80)}` } : { name, ok: true }); } catch (e) { out.push({ name, ok: true, error: `network: ${(e as Error).message.slice(0, 40)}` }); } // a network blip is not a dead token
  }
  return out;
}
export function tiktokTokenInfo(cfg: Config): { connected: boolean; expiresAt?: number; refreshExpiresAt?: number } {
  let t: { access_token?: string; expires_at?: number; refresh_expires_at?: number } | null = null; try { t = secretsOf(cfg).read('tiktok'); } catch { t = null; }
  return t?.access_token ? { connected: true, expiresAt: t.expires_at, refreshExpiresAt: t.refresh_expires_at } : { connected: false };
}

/** All Facebook Pages (and whether each has an Instagram account) from the last Meta login. No tokens leave this function. */
export function metaPages(cfg: Config): { id: string; name: string; instagram: boolean }[] {
  try { const d = secretsOf(cfg).read<{ pages?: { id: string; name: string; ig_user_id: string | null }[] }>('meta-pages'); return (d?.pages ?? []).map((p) => ({ id: p.id, name: p.name, instagram: !!p.ig_user_id })); } catch { return []; }
}
/** Point one channel at one Page (+ its Instagram): the channel then publishes there instead of the default account. pageId '' = back to default. */
export function assignMetaPage(cfg: Config, slug: string, pageId: string): { page: string; instagram: boolean } | null {
  const sec = secretsOf(cfg); if (!/^[a-z0-9-]{1,40}$/.test(slug)) throw new Error('invalid: channel slug');
  if (!pageId) { for (const n of ['facebook', 'instagram']) try { sec.write(`${n}-${slug}`, {}); } catch { /* none */ } return null; }
  const d = sec.read<{ pages?: MetaPage[]; user_token?: string; perms?: string[] }>('meta-pages'); const pg = d?.pages?.find((p) => p.id === pageId);
  if (!pg) throw new Error('invalid: Page not found in the last Meta login (login again)');
  sec.write(`facebook-${slug}`, { access_token: pg.access_token, page_id: pg.id, page_name: pg.name, perms: d?.perms ?? [], connected_at: new Date().toISOString() });
  if (pg.ig_user_id) sec.write(`instagram-${slug}`, { access_token: pg.ut ?? d?.user_token ?? pg.access_token, page_token: pg.access_token, ig_user_id: pg.ig_user_id, perms: d?.perms ?? [], connected_at: new Date().toISOString() }); else sec.write(`instagram-${slug}`, {});
  return { page: pg.name, instagram: !!pg.ig_user_id };
}
