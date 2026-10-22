import type { SecretStore } from './secrets.ts';

const base = () => process.env.YT_OAUTH_BASE ?? 'https://oauth2.googleapis.com';
/** `youtube` is allowed by Google's device flow and covers upload, list, update and thumbnails (verified in Google's docs 2026-10-22). */
export const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';

async function form(url: string, body: Record<string, string>): Promise<{ status: number; json: any }> {
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
export async function pollDeviceFlow(secrets: SecretStore, clientId: string, clientSecret: string, deviceCode: string): Promise<PollResult> {
  const r = await form(`${base()}/token`, { client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  if (r.status === 200 && r.json.refresh_token) { secrets.write('youtube', { refresh_token: r.json.refresh_token, connected_at: new Date().toISOString() }); return { status: 'ok', refreshToken: r.json.refresh_token }; }
  switch (r.json.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down': return { status: 'slow_down' };
    case 'access_denied': return { status: 'denied' };
    case 'expired_token': return { status: 'expired' };
    default: throw new Error(`AUTH_DEVICE_POLL_FAILED: ${r.json.error ?? r.status}`);
  }
}

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
  constructor(secrets: SecretStore) { this.secrets = secrets; }
  connected(): boolean { try { return !!this.secrets.read<{ refresh_token?: string }>('youtube')?.refresh_token; } catch { return false; } }
  async accessToken(): Promise<string> {
    if (this.cache && this.cache.exp > Date.now() + 60_000) return this.cache.token;
    const creds = clientCreds(this.secrets); if (!creds) throw new Error('AUTH_NOT_CONFIGURED: set YT_OAUTH_CLIENT_ID and YT_OAUTH_CLIENT_SECRET');
    const rt = this.secrets.read<{ refresh_token?: string }>('youtube')?.refresh_token; if (!rt) throw new Error('AUTH_NOT_CONNECTED: connect the YouTube account first');
    const r = await form(`${base()}/token`, { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: rt, grant_type: 'refresh_token' });
    if (r.status === 200 && r.json.access_token) { this.cache = { token: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 }; return r.json.access_token; }
    this.cache = null;
    if (r.json.error === 'invalid_grant' || r.json.error === 'invalid_client' || r.json.error === 'unauthorized_client') throw new Error(`AUTH_REVOKED: ${r.json.error} — reconnect the YouTube account`);
    throw new Error(`AUTH_REFRESH_FAILED: ${r.json.error ?? r.status}`);
  }
}
