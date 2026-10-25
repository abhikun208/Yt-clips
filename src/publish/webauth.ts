import { randomBytes, createHash } from 'node:crypto';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import type { Channel } from '../channels.ts';
import { getChannel, ytSecretName } from '../channels.ts';
import { clientCreds, form, base, authBase, YT_FORCE_SSL_SCOPE, YT_ANALYTICS_SCOPE } from './oauth.ts';
import { secretsFor, tokenFor } from './service.ts';
import { YouTubeAdapter } from './youtube.ts';

/**
 * "Login with Google" in the owner's (or a shared-link person's) browser: the person picks their Google account on Google's own page and
 * presses Allow. This server only ever receives a one-time `code`, trades it for a refresh token and stores it ENCRYPTED in the secret store.
 * No password is typed anywhere in this project; the token is never returned by any API, shown in the UI or written to logs.
 * The UI only gets back the connection identity (YouTube channel id + title) as the "connected" confirmation.
 */
export const YT_WEB_SCOPE = `https://www.googleapis.com/auth/youtube.upload ${YT_FORCE_SSL_SCOPE} ${YT_ANALYTICS_SCOPE}`;
const TTL_MS = 30 * 60_000;
const key = (s: string) => `ytweb:${s}`;
export interface WebStart { authUrl: string; redirectUri: string; share: boolean; expiresInSec: number }

export const PASTE_REDIRECT = 'http://127.0.0.1:8765/';
export function startWebAuth(store: Store, cfg: Config, ch: Channel, o: { base: string; share?: boolean; paste?: boolean }): WebStart {
  const cc = clientCreds(secretsFor(cfg)); if (!cc) throw new Error('invalid: pehle Google client ID/secret save karo (Setup → Social accounts login → YouTube)');
  const redirectUri = o.paste ? PASTE_REDIRECT : `${o.base.replace(/\/+$/, '')}/api/oauth/youtube/callback`;
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(24).toString('hex');
  store.exec(`DELETE FROM kv WHERE k LIKE 'ytweb:%' AND json_extract(v,'$.exp') < ?`, Date.now()); // expired states never pile up
  store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, key(state), JSON.stringify({ slug: ch.slug, verifier, redirectUri, exp: Date.now() + TTL_MS, share: !!o.share }));
  if (o.paste) store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `ytweb-last:${ch.slug}`, state);
  const q = new URLSearchParams({ client_id: cc.clientId, redirect_uri: redirectUri, response_type: 'code', scope: YT_WEB_SCOPE, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state });
  return { authUrl: `${authBase()}?${q}`, redirectUri, share: !!o.share, expiresInSec: TTL_MS / 1000 };
}

export interface Identity { channelId: string; title: string; at: string }
export const identityOf = (store: Store, slug: string): Identity | null => { try { const v = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `ytinfo:${slug}`)?.v; return v ? JSON.parse(v) as Identity : null; } catch { return null; } };

/** Finishes the redirect. The state is single-use and expires after 30 min; errors never echo the code/token. */
export async function finishWebAuth(store: Store, cfg: Config, q: { code: string | null; state: string | null; error: string | null }): Promise<{ slug: string; identity: Identity | null }> {
  const row = q.state ? store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', key(q.state)) : undefined; if (q.state) store.exec('DELETE FROM kv WHERE k=?', key(q.state));
  if (!row) throw new Error('link expire ya pehle hi use ho chuka — Connect dobara dabao');
  const st = JSON.parse(row.v) as { slug: string; verifier: string; redirectUri: string; exp: number };
  if (st.exp < Date.now()) throw new Error('link expire ho gaya (30 min) — dobara banao');
  if (q.error) throw new Error(q.error === 'access_denied' ? 'aapne Allow nahi dabaya' : `Google error: ${q.error.slice(0, 40)}`);
  if (!q.code) throw new Error('Google se code nahi aaya');
  const cc = clientCreds(secretsFor(cfg)); if (!cc) throw new Error('Google client ID/secret nahi mila');
  const r = await form(`${base()}/token`, { client_id: cc.clientId, client_secret: cc.clientSecret, code: q.code, code_verifier: st.verifier, redirect_uri: st.redirectUri, grant_type: 'authorization_code' });
  if (r.status !== 200 || !r.json.refresh_token) throw new Error(r.json.error === 'invalid_client' ? 'Google client ID/secret galat hai' : r.json.error === 'redirect_uri_mismatch' ? `redirect URI Google Console mein add karo: ${st.redirectUri}` : `token nahi mila (${String(r.json.error ?? r.status).slice(0, 40)}). Gmail ko "Test users" mein add karo ya app ko In production karo`);
  const ch = getChannel(store, st.slug);
  secretsFor(cfg).write(ytSecretName(ch), { refresh_token: r.json.refresh_token, scope: r.json.scope ?? YT_WEB_SCOPE, connected_at: new Date().toISOString() });
  let identity: Identity | null = null;
  try { const w = await new YouTubeAdapter(store, tokenFor(cfg, ch)).whoami(); if (w) { identity = { channelId: w.id, title: w.title, at: new Date().toISOString() }; store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')`, `ytinfo:${st.slug}`, JSON.stringify(identity)); } } catch { /* connected, identity lookup can be retried with Test */ }
  store.logState('youtube-connect', ch.id, null, 'connected', identity ? identity.channelId : 'no identity yet');
  return { slug: st.slug, identity };
}

/**
 * "Paste" mode (no redirect URI to register): works with a Google "Desktop app" OAuth client from ANY device. After Allow, Google sends the browser to
 * http://127.0.0.1:8765/?code=...&state=... (that page will not load, which is expected); the owner pastes that address (or just the code) here.
 */
export async function finishPaste(store: Store, cfg: Config, slug: string, pasted: string): Promise<{ slug: string; identity: Identity | null }> {
  const t = pasted.trim(); let code: string | null = null, state: string | null = null, error: string | null = null;
  try { const u = new URL(t); code = u.searchParams.get('code'); state = u.searchParams.get('state'); error = u.searchParams.get('error'); } catch { code = /^[\w./~-]{10,300}$/.test(t) ? t : null; }
  if (!state) state = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `ytweb-last:${slug}`)?.v ?? null;
  if (!code && !error) throw new Error('paste: address bar ka poora link (ya sirf code) daalo');
  return finishWebAuth(store, cfg, { code, state, error });
}
