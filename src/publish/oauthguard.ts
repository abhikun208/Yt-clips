import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { handleCallback, redirectUri, type SocialApp } from './socialOauth.ts';
import { info, warn } from '../util/log.ts';
import { getTunnelUrl } from '../ops/tunnel.ts';

/**
 * Safe wrapper around the Facebook/Instagram (one Meta app) and TikTok logins.
 *  - redirect base comes from .env (OAUTH_PUBLIC_BASE_URL, or PUBLIC_URL) so a tunnel/domain works from Termux; otherwise it is derived from the request
 *  - HTTPS rules per platform (TikTok: https + real domain; Meta: https, or http only for localhost/127.0.0.1 = developer mode)
 *  - the redirect URI used at /start is remembered with the login state; if /callback arrives on another host/protocol the user gets a plain-language fix, not a provider error
 *  - provider errors (access_denied, redirect_uri mismatch, expired state ...) are translated to short Hinglish messages
 * Nothing here talks to the network except handleCallback (existing code).
 */
export type OAuthPlatform = 'facebook' | 'instagram' | 'tiktok';
export const toApp = (p: string): SocialApp => (p === 'tiktok' ? 'tiktok' : 'facebook'); // Instagram publishing/insights ride on the Meta app
const isLocal = (h: string): boolean => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/.test(h);
const isIp = (h: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(h);

export interface RedirectCheck { ok: boolean; uri: string; secure: boolean; local: boolean; problems: string[]; hint: string; badge: string }
/** https address the owner pasted in Settings (a domain, or a tunnel link already registered in Meta/TikTok). Beats the auto tunnel. */
let savedBase: string | null = null;
/** hosts that belong to the tunnel providers themselves (api.trycloudflare.com answers "Method Not Allowed" to every login redirect) */
export const providerHost = (h: string): boolean => /^(api|www|admin|docs|dash)\.(trycloudflare\.com|serveo\.net|localhost\.run|lhr\.life)$/i.test(h) || /^(trycloudflare\.com|serveo\.net|localhost\.run)$/i.test(h);
export const cleanBase = (v: string): string | null => { try { const u = new URL(v.trim()); return u.protocol === 'https:' && u.hostname.includes('.') && !providerHost(u.hostname) ? u.origin : null; } catch { return null; } };
export function setSavedBase(v: string | null): void { savedBase = v ? cleanBase(v) : null; }
export const getSavedBase = (): string | null => savedBase;
export function resolveBase(req: { proto?: string; host?: string; fwdHost?: string }): string {
  // zero-config: tunnel/proxy headers first (X-Forwarded-Proto/Host), the Host header next; .env is only an optional override
  const env = process.env.OAUTH_PUBLIC_BASE_URL || process.env.PUBLIC_URL; if (env) return env.replace(/\/+$/, '');
  if (savedBase) return savedBase;
  const tun = getTunnelUrl(); if (tun) return tun; // cloudflared quick tunnel started by the server
  const host = (req.fwdHost || req.host || '127.0.0.1').split(',')[0]!.trim(); const proto = (req.proto || '').split(',')[0]!.trim() === 'https' ? 'https' : 'http';
  return `${proto}://${host}`.replace(/\/+$/, '');
}
export function checkRedirect(platform: OAuthPlatform, base: string): RedirectCheck {
  const app = toApp(platform); const uri = redirectUri(base, app); const problems: string[] = []; let u: URL | null = null;
  try { u = new URL(uri); } catch { problems.push(`Redirect URL galat hai: "${base}"`); }
  const host = u?.hostname ?? ''; if (u && providerHost(host)) problems.push(`${host} tunnel company ka apna server hai, tumhara nahi (isi se "Method Not Allowed" aata hai). Meta me ye URI hata do; apna link jaise https://<random-words>.trycloudflare.com ya https://ytc-xxxx.serveo.net hona chahiye.`); const https = u?.protocol === 'https:'; const local = isLocal(host);
  if (u) {
    if (app === 'tiktok') { if (!https || local || isIp(host)) problems.push('TikTok sirf HTTPS + asli domain wala redirect maanta hai (localhost / IP nahi chalega).'); }
    else if (!https) problems.push(local ? 'Meta ka dashboard ab http://localhost / 127.0.0.1 redirect register nahi karta ("Enter a valid HTTPS URL").' : 'Meta (Facebook/Instagram) ko HTTPS redirect chahiye.');
  }
  const hint = problems.length ? 'Free HTTPS: Termux me `pkg install cloudflared`, phir `YT_CLIPS_TUNNEL=1 npm start` (link apne aap ban jaata hai, .env nahi chahiye). Ya apna domain/ngrok proxy lagao. Phir ye URI app ke "Valid OAuth Redirect URIs" me daalo: ' + uri : `Provider app me ye redirect URI daalo: ${uri}`;
  return { ok: !problems.length, uri, secure: https, local, problems, hint, badge: !problems.length ? (https ? '🔒 Secure (HTTPS)' : '✅ HTTPS') : '⚠ HTTPS chahiye' };
}

const PROVIDER_ERR: Record<string, string> = { access_denied: 'Tumne permission cancel/deny kar di. Dobara try karo aur saari permissions allow karo.', user_cancelled_login: 'Login beech me cancel ho gaya.', user_cancelled_authorize: 'Authorize cancel ho gaya.' };
export function friendlyOAuthError(msg: string): string {
  const m = msg.replace(/^oauth:\s*/i, '').replace(/^invalid:\s*/i, '');
  const e = Object.keys(PROVIDER_ERR).find((k) => m.includes(k)); if (e) return PROVIDER_ERR[e]!;
  if (/redirect_uri|redirect uri|URL Blocked|domain of this URL/i.test(m)) return 'Redirect URI app me register nahi hai ya match nahi kar raha. App settings me bilkul wahi URI daalo jo yahan "Callback" me dikhta hai (http/https aur slash tak same).';
  if (/expired|unknown or expired/i.test(m)) return 'Login ka time khatam ya link purana hai (10 min). Connect button dobara dabao.';
  if (/no Facebook Page found/i.test(m)) return 'Login ho gaya par koi Facebook Page nahi mila. Meta dialog me "Edit access"/Pages me apna Page SELECT karo, aur tum us Page ke admin hone chahiye. App Development mode me ho to tumhara account app me Admin/Tester hona chahiye. Phir Connect dobara dabao.';
  if (/Invalid Scopes|scope/i.test(m)) return 'Meta ne permission (scope) mana ki: App ke Use case/Products me Pages + Instagram permissions add karo (Development mode me tum khud admin ho to review nahi chahiye). Detail: ' + m.slice(0, 100);
  if (/missing code/i.test(m)) return 'Provider ne code nahi bheja. Connect button se dobara shuru karo.';
  if (/secret|client_secret|Invalid client|app id/i.test(m)) return 'App ID/Secret galat lagte hain. Settings me dobara paste karo.';
  return `Login fail: ${m.slice(0, 160)}`;
}

/** The universal callback: validates https/host, then runs the existing exchange. Never throws: returns what to show the user. */
const remember = (store: Store, app: string, v: { ok: boolean; message: string; raw?: string }): void => { try { store.exec('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', `oauth:last:${app}`, JSON.stringify({ ...v, at: new Date().toISOString() })); } catch { /* diagnostics only */ } };
export const lastOAuth = (store: Store, app: string): { ok: boolean; message: string; raw?: string; at: string } | null => { try { const v = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `oauth:last:${app}`)?.v; return v ? JSON.parse(v) : null; } catch { return null; } };
export function handleOAuthCallback(platform: OAuthPlatform) {
  return async (store: Store, cfg: Config, q: { code?: string | null; state?: string | null; error?: string | null; error_description?: string | null }, req: { proto?: string; host?: string; fwdHost?: string }): Promise<{ ok: boolean; status: number; message: string }> => {
    const app = toApp(platform);
    try {
      const base = resolveBase(req); const chk = checkRedirect(platform, base);
      if (q.error) { const m = friendlyOAuthError(`${q.error} ${q.error_description ?? ''}`); remember(store, app, { ok: false, message: m, raw: `${q.error} ${q.error_description ?? ''}`.slice(0, 200) }); return { ok: false, status: 400, message: m }; }
      const st = q.state ? store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `oauth_state_${q.state}`)?.v : undefined; let used = ''; try { used = st ? (JSON.parse(st) as { ru?: string }).ru ?? '' : ''; } catch { /* old state */ }
      if (used && used !== chk.uri) return { ok: false, status: 400, message: `Login ek address par shuru hua (${used}) aur doosre par wapas aaya (${chk.uri}). Same address (same http/https + host) se shuru aur khatam karo, ya .env me OAUTH_PUBLIC_BASE_URL fix karo.` };
      const r = await handleCallback(store, cfg, app, { code: q.code, state: q.state, error: q.error }, base);
      info('oauth connected', { app, accounts: r.connected.length }); remember(store, app, { ok: true, message: `Connected: ${r.connected.join(', ')}${r.note ? ' — ' + r.note : ''}` }); return { ok: true, status: 200, message: `Connected: ${r.connected.join(', ')}${r.note ? ' (' + r.note + ')' : ''}` };
    } catch (e) { const m = friendlyOAuthError((e as Error).message); warn('oauth callback failed', { app, why: (e as Error).message.slice(0, 160) }); remember(store, app, { ok: false, message: m, raw: (e as Error).message.slice(0, 300) }); return { ok: false, status: 400, message: m }; }
  };
}
