import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import type { SecretStore } from './secrets.ts';

export const base = () => process.env.YT_OAUTH_BASE ?? 'https://oauth2.googleapis.com';
/** `youtube` is allowed by Google's device flow and covers upload, list, update and thumbnails (verified in Google's docs 2026-10-22). */
export const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';

export async function form(url: string, body: Record<string, string>): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

export interface DeviceStart { device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number }
export async function startDeviceFlow(clientId: string): Promise<DeviceStart> {
  const r = await form(`${base()}/device/code`, { client_id: clientId, scope: YT_SCOPE });
  if (r.status !== 200 || !r.json.device_code) throw new Error(`AUTH_DEVICE_START_FAILED: ${r.json.error ?? r.status} ${r.json.error_description ?? ''}`.trim());
  return { device_code: r.json.device_code, user_code: r.json.user_code, verification_url: r.json.verification_url ?? r.json.verification_uri, expires_in: r.json.expires_in, interval: r.json.interval ?? 5 };
}
export type PollResult = { status: 'pending' | 'slow_down' | 'denied' | 'expired' } | { status: 'ok'; refreshToken: string };
/** One poll of the device flow. On success the refresh token is persisted (encrypted when YT_CLIPS_SECRET_KEY is set). */
export async function pollDeviceFlow(secrets: SecretStore, clientId: string, clientSecret: string, deviceCode: string, name = 'youtube'): Promise<PollResult> {
  const r = await form(`${base()}/token`, { client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  if (r.status === 200 && r.json.refresh_token) { secrets.write(name, { refresh_token: r.json.refresh_token, connected_at: new Date().toISOString() }); return { status: 'ok', refreshToken: r.json.refresh_token }; }
  switch (r.json.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down': return { status: 'slow_down' };
    case 'access_denied': return { status: 'denied' };
    case 'expired_token': return { status: 'expired' };
    default: throw new Error(`AUTH_DEVICE_POLL_FAILED: ${r.json.error ?? r.status}`);
  }
}

/** Needed to post comment replies (comments.insert lists only this scope in Google's docs, fetched 2026-10-22). NOT allowed in the device flow, hence the loopback flow below. */
export const YT_FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
/** Analytics (retention) read scope. NOT allowed in the device flow, so it comes with the loopback flow together with force-ssl. */
export const YT_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
export const authBase = () => process.env.YT_OAUTH_AUTH_BASE ?? 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Installed-app OAuth (loopback redirect + PKCE) for the force-ssl scope. Starts a one-shot HTTP listener on 127.0.0.1; the owner opens
 * `authUrl` in a browser ON THE SAME MACHINE (on a VPS: `ssh -L PORT:127.0.0.1:PORT`). `done` resolves after the refresh token is stored.
 */
export async function startLoopbackFlow(secrets: SecretStore, creds: { clientId: string; clientSecret: string }, o: { port?: number; timeoutMs?: number; scope?: string; name?: string } = {}): Promise<{ authUrl: string; port: number; done: Promise<void>; cancel(): void }> {
  const verifier = randomBytes(32).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url'); const state = randomBytes(16).toString('hex');
  let resolve!: () => void, reject!: (e: Error) => void; const done = new Promise<void>((a, b) => { resolve = a; reject = b; }); done.catch(() => {});
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1'); if (u.pathname !== '/callback') { res.writeHead(404); return void res.end(); }
    const fail = (m: string) => { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(`Failed: ${m}`); reject(new Error(`AUTH_LOOPBACK_FAILED: ${m}`)); close(); };
    if (u.searchParams.get('state') !== state) return fail('state mismatch'); if (u.searchParams.get('error')) return fail(String(u.searchParams.get('error')).slice(0, 60));
    const code = u.searchParams.get('code'); if (!code) return fail('no code');
    const port = (srv.address() as { port: number }).port;
    const r = await form(`${base()}/token`, { client_id: creds.clientId, client_secret: creds.clientSecret, code, code_verifier: verifier, redirect_uri: `http://127.0.0.1:${port}/callback`, grant_type: 'authorization_code' });
    if (r.status !== 200 || !r.json.refresh_token) return fail(String(r.json.error ?? r.status));
    secrets.write(o.name ?? 'youtube', { refresh_token: r.json.refresh_token, scope: r.json.scope ?? o.scope ?? `${YT_FORCE_SSL_SCOPE} ${YT_ANALYTICS_SCOPE}`, connected_at: new Date().toISOString() });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Connected. Is tab ko band kar sakte ho.'); resolve(); close();
  });
  const timer = setTimeout(() => { reject(new Error('AUTH_LOOPBACK_TIMEOUT')); close(); }, o.timeoutMs ?? 10 * 60_000); timer.unref();
  const close = () => { clearTimeout(timer); srv.close(); srv.closeAllConnections?.(); };
  await new Promise<void>((ok) => srv.listen(o.port ?? 0, '127.0.0.1', ok)); const port = (srv.address() as { port: number }).port;
  const q = new URLSearchParams({ client_id: creds.clientId, redirect_uri: `http://127.0.0.1:${port}/callback`, response_type: 'code', scope: o.scope ?? `${YT_FORCE_SSL_SCOPE} ${YT_ANALYTICS_SCOPE}`, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state });
  return { authUrl: `${authBase()}?${q}`, port, done, cancel: () => { reject(new Error('cancelled')); close(); } };
}

/** Scope string recorded at connect time (device flow records none => the `youtube` scope). */
export function connectedScope(secrets: SecretStore, name = 'youtube'): string | null { try { const s = secrets.read<{ refresh_token?: string; scope?: string }>(name); return s?.refresh_token ? (s.scope ?? YT_SCOPE) : null; } catch { return null; } }

export interface ClientCreds { clientId: string; clientSecret: string }
export function clientCreds(secrets: SecretStore): ClientCreds | null {
  const id = process.env.YT_OAUTH_CLIENT_ID, sec = process.env.YT_OAUTH_CLIENT_SECRET;
  if (id && sec) return { clientId: id, clientSecret: sec };
  const s = secrets.read<{ client_id?: string; client_secret?: string }>('youtube-client');
  return s?.client_id && s.client_secret ? { clientId: s.client_id, clientSecret: s.client_secret } : null;
}

/** Access-token provider with in-memory cache. invalid_grant (revoked/expired) => AUTH_REVOKED so callers stop instead of retrying forever. */
export class TokenProvider {
  private cache: { token: string; exp: number } | null = null;
  private secrets: SecretStore;
  private name: string;
  constructor(secrets: SecretStore, name = 'youtube') { this.secrets = secrets; this.name = name; }
  connected(): boolean { try { return !!this.secrets.read<{ refresh_token?: string }>(this.name)?.refresh_token; } catch { return false; } }
  async accessToken(): Promise<string> {
    if (this.cache && this.cache.exp > Date.now() + 60_000) return this.cache.token;
    const creds = clientCreds(this.secrets); if (!creds) throw new Error('AUTH_NOT_CONFIGURED: set YT_OAUTH_CLIENT_ID and YT_OAUTH_CLIENT_SECRET');
    const rt = this.secrets.read<{ refresh_token?: string }>(this.name)?.refresh_token; if (!rt) throw new Error('AUTH_NOT_CONNECTED: connect the YouTube account first');
    const r = await form(`${base()}/token`, { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: rt, grant_type: 'refresh_token' });
    if (r.status === 200 && r.json.access_token) { this.cache = { token: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 }; return r.json.access_token; }
    this.cache = null;
    if (r.json.error === 'invalid_grant' || r.json.error === 'invalid_client' || r.json.error === 'unauthorized_client') throw new Error(`AUTH_REVOKED: ${r.json.error} — reconnect the YouTube account`);
    throw new Error(`AUTH_REFRESH_FAILED: ${r.json.error ?? r.status}`);
  }
}
