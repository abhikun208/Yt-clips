import type { SecretStore } from '../publish/secrets.ts';
import type { YouTubeAdapter } from '../publish/youtube.ts';

export interface Stat { remoteId: string; publishedAt: string | null; views: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; reach?: number | null; avgWatchSec?: number | null }
export interface Provider { readonly platform: string; /** when set, only this channel's uploads are fetched (per-channel tokens) */ readonly channelId?: number; connected(): boolean; fetch(remoteIds: string[]): Promise<Stat[]> }

const GRAPH = () => process.env.GRAPH_API_BASE ?? 'https://graph.facebook.com/v26.0';
const TIKTOK = () => process.env.TIKTOK_API_BASE ?? 'https://open.tiktokapis.com';
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
const iso = (x: unknown): string | null => { const t = typeof x === 'number' ? x * 1000 : Date.parse(String(x ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

async function getJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; j: any }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); let j: any = null; try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 401 || (j?.error?.code === 190)) throw new Error('AUTH_REVOKED: access token rejected (re-supply a fresh token)');
  if (r.status === 429 || [4, 17, 32, 613].includes(j?.error?.code)) throw new Error('QUOTA_EXCEEDED: platform rate limit');
  return { ok: r.ok, status: r.status, j };
}
const token = (secrets: SecretStore, name: string) => secrets.read<{ access_token?: string }>(name)?.access_token ?? null;

/** YouTube: videos.list statistics (public counters). Uses the connected OAuth token + the shared quota accounting. */
export function youtubeProvider(ad: YouTubeAdapter, connected: () => boolean): Provider {
  return { platform: 'youtube_shorts', connected, async fetch(ids) { return (await ad.stats(ids)).map((v) => ({ remoteId: v.id, publishedAt: v.publishedAt, views: v.views, likes: v.likes, comments: v.comments })); } };
}

/** Instagram Graph API media insights (Reels/feed). Needs instagram_manage_insights (FB login) / instagram_business_manage_insights (IG login). Metrics per Meta docs fetched 2026-10-22. */
export function instagramProvider(secrets: SecretStore): Provider {
  return { platform: 'instagram_reels', connected: () => { try { return !!token(secrets, 'instagram'); } catch { return false; } },
    async fetch(ids) {
      const t = token(secrets, 'instagram'); if (!t) throw new Error('AUTH_NOT_CONNECTED: no instagram access token'); const out: Stat[] = [];
      for (const id of ids) {
        const meta = await getJson(`${GRAPH()}/${encodeURIComponent(id)}?fields=timestamp&access_token=${encodeURIComponent(t)}`);
        let ins = await getJson(`${GRAPH()}/${encodeURIComponent(id)}/insights?metric=views,reach,likes,comments,shares,saved,ig_reels_avg_watch_time&access_token=${encodeURIComponent(t)}`);
        if (!ins.ok) ins = await getJson(`${GRAPH()}/${encodeURIComponent(id)}/insights?metric=views&access_token=${encodeURIComponent(t)}`); // some metrics are not valid for every media type
        if (!ins.ok) continue; // media not readable: skip, never fabricate
        const m: Record<string, number | null> = {}; for (const d of (ins.j?.data ?? []) as any[]) m[d.name] = num(d.total_value?.value ?? d.values?.[0]?.value);
        out.push({ remoteId: id, publishedAt: iso(meta.j?.timestamp), views: m.views ?? null, reach: m.reach ?? null, likes: m.likes ?? null, comments: m.comments ?? null, shares: m.shares ?? null, saves: m.saved ?? null, avgWatchSec: m.ig_reels_avg_watch_time != null ? m.ig_reels_avg_watch_time / 1000 : null });
      }
      return out;
    } };
}

/** Facebook Page video insights (total_video_views). Needs a Page token with pages_read_engagement. */
export function facebookProvider(secrets: SecretStore): Provider {
  return { platform: 'facebook_reels', connected: () => { try { return !!token(secrets, 'facebook'); } catch { return false; } },
    async fetch(ids) {
      const t = token(secrets, 'facebook'); if (!t) throw new Error('AUTH_NOT_CONNECTED: no facebook page token'); const out: Stat[] = [];
      for (const id of ids) {
        const meta = await getJson(`${GRAPH()}/${encodeURIComponent(id)}?fields=created_time&access_token=${encodeURIComponent(t)}`);
        const ins = await getJson(`${GRAPH()}/${encodeURIComponent(id)}/video_insights?metric=total_video_views&access_token=${encodeURIComponent(t)}`); if (!ins.ok) continue;
        const d = ((ins.j?.data ?? []) as any[]).find((x) => x.name === 'total_video_views');
        out.push({ remoteId: id, publishedAt: iso(meta.j?.created_time), views: num(d?.values?.[0]?.value) });
      }
      return out;
    } };
}

/** TikTok Display API: POST /v2/video/query/ (scope video.list, <=20 ids per call). Token supplied by the owner (no refresh logic here). */
export function tiktokProvider(secrets: SecretStore, getToken?: () => Promise<string | null>): Provider {
  return { platform: 'tiktok', connected: () => { try { return !!token(secrets, 'tiktok'); } catch { return false; } },
    async fetch(ids) {
      const t = getToken ? await getToken() : token(secrets, 'tiktok'); if (!t) throw new Error('AUTH_NOT_CONNECTED: no tiktok access token'); const out: Stat[] = [];
      for (let i = 0; i < ids.length; i += 20) {
        const r = await getJson(`${TIKTOK()}/v2/video/query/?fields=id,create_time,view_count,like_count,comment_count,share_count`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ filters: { video_ids: ids.slice(i, i + 20) } }) });
        if (!r.ok) { if (r.j?.error?.code && r.j.error.code !== 'ok') throw new Error(`tiktok query failed: ${String(r.j.error.code).slice(0, 60)}`); continue; }
        for (const v of (r.j?.data?.videos ?? []) as any[]) out.push({ remoteId: String(v.id), publishedAt: iso(num(v.create_time)), views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count) });
      }
      return out;
    } };
}
