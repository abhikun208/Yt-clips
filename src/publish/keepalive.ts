import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { listChannels, ytSecretName } from '../channels.ts';
import { SecretStore } from './secrets.ts';
import { TokenProvider } from './oauth.ts';
import { tiktokAccessToken, tiktokTokenInfo, metaTokenStatus } from './socialOauth.ts';
import { notify } from '../notify.ts';
import { info, warn } from '../util/log.ts';

/**
 * Keep every platform login ALIVE without the owner (no passwords, no browser cookies: only the official OAuth refresh tokens):
 *  - YouTube: a refresh token that is never used can lapse; one access-token refresh per day counts as use and proves the login still works.
 *    A refresh token that dies within ~7 days of connecting almost always means the Google OAuth app is still in "Testing" mode (Google expires those after 7 days) -> told to the owner in plain words.
 *  - TikTok: the 24 h access token is renewed BEFORE it expires (the refresh token rotates and is valid ~365 days; warned 30 days ahead).
 *  - Meta (Facebook/Instagram): token validity check (page tokens from a long-lived login do not expire; password change / removed app access kills them).
 * When something is dead the owner gets ONE Telegram message per day with the exact fix; uploads of that platform wait (never fail), rendering continues.
 */
export interface KeepAliveReport { youtube: Record<string, 'ok' | 'dead' | 'skip'>; tiktok: 'ok' | 'renewed' | 'dead' | 'skip'; meta: Record<string, 'ok' | 'dead'>; alerts: string[] }
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

export async function keepAliveTick(store: Store, cfg: Config, now = Date.now()): Promise<KeepAliveReport> {
  const rep: KeepAliveReport = { youtube: {}, tiktok: 'skip', meta: {}, alerts: [] };
  const alert = async (key: string, text: string) => { rep.alerts.push(text); await notify(store, cfg, `${key}:${day(now)}`, text); warn('login needs the owner', { key }); };
  const secrets = SecretStore.forData(cfg.dataDir);

  for (const ch of listChannels(store)) {
    const name = ytSecretName(ch); const tp = new TokenProvider(secrets, name); if (!tp.connected()) { rep.youtube[ch.slug] = 'skip'; continue; }
    try { await tp.accessToken(); rep.youtube[ch.slug] = 'ok'; }
    catch (e) {
      const m = (e as Error).message; if (!/^AUTH_(REVOKED|NOT_CONNECTED)/.test(m)) { rep.youtube[ch.slug] = 'skip'; continue; } // network / Google hiccup: try again next tick
      rep.youtube[ch.slug] = 'dead'; let ageDays = Infinity; try { const at = secrets.read<{ connected_at?: string }>(name)?.connected_at; if (at) ageDays = (now - Date.parse(at)) / 86_400_000; } catch { /* unknown age */ }
      await alert(`yt-dead:${ch.slug}`, `⚠️ YouTube login (${ch.slug}) expire ho gaya. ${ageDays <= 8 ? 'Ye connect ke 7 din ke andar hua = Google OAuth app abhi "Testing" mode me hai. Google Cloud Console → OAuth consent screen → "Publish app" (In production) karo, phir ek baar dobara connect karo - uske baad login expire nahi hoga. ' : ''}Setup → YouTube → Connect. Tab tak uploads ruke rahenge, video banti rahengi.`);
    }
  }

  const tt = tiktokTokenInfo(cfg);
  if (tt.connected) {
    try {
      if (tt.expiresAt && tt.expiresAt - now < 12 * 3600_000) { await tiktokAccessToken(cfg, true); rep.tiktok = 'renewed'; info('keep-alive: TikTok token renewed'); } else rep.tiktok = 'ok';
      if (tt.refreshExpiresAt && tt.refreshExpiresAt - now < 30 * 86_400_000) await alert('tt-soon', `ℹ️ TikTok login ${Math.max(0, Math.round((tt.refreshExpiresAt - now) / 86_400_000))} din me expire hoga. Setup me ek baar dobara connect kar lo.`);
    } catch (e) { if (/^AUTH_/.test((e as Error).message)) { rep.tiktok = 'dead'; await alert('tt-dead', '⚠️ TikTok login expire ho gaya. Setup → TikTok → Connect. Tab tak TikTok uploads ruke rahenge.'); } }
  }

  for (const s of await metaTokenStatus(cfg)) { if (s.ok) { rep.meta[s.name] = 'ok'; continue; } rep.meta[s.name] = 'dead'; await alert(`meta-dead:${s.name}`, `⚠️ ${s.name === 'instagram' ? 'Instagram' : 'Facebook'} login expire/revoke ho gaya (${s.error}). Setup → Facebook/Instagram → Connect (password badalne ya app access hatane par aisa hota hai).`); }
  return rep;
}
