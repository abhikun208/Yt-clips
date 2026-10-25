import { randomBytes } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { StagedAdapter } from './direct.ts';
import { SecretStore } from './secrets.ts';

/**
 * Facebook Reels (Page) + Instagram Reels publishing through the Meta Graph API.
 * Flow per Meta docs (read 2026-10-25): Facebook = POST /{page}/video_reels start -> rupload.facebook.com/video-upload/{id} -> POST finish;
 * Instagram = POST /{ig}/media (REELS, video_url) -> poll status_code -> POST /{ig}/media_publish. Instagram needs a PUBLIC video URL
 * (Meta fetches it): this server hands out an unguessable, expiring link for exactly that one file. Without a public URL the documented
 * resumable upload is tried instead (Meta limits it to apps using Facebook Login for Business, so it may be refused: the error says so).
 * Like every other adapter, upload() only stages; the single real request sequence runs at publish(), after the owner's gates.
 * NEVER run against real Meta by the author (sandbox network policy); the tests use a local stand-in.
 */
const VER = 'v26.0';
const graph = () => process.env.GRAPH_API_BASE ?? `https://graph.facebook.com/${VER}`;
const rupload = () => process.env.META_RUPLOAD_BASE ?? 'https://rupload.facebook.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pollMs = () => Number(process.env.META_POLL_MS ?? 15_000);

async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; j: any }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) }); let j: any = null; try { j = await r.json(); } catch { /* empty */ }
  const code = j?.error?.code;
  if (r.status === 401 || code === 190 || code === 102) throw new Error('AUTH_META: access token rejected/expired — Publish → Facebook/Instagram → Connect again');
  if ([4, 17, 32, 613].includes(code) || r.status === 429) throw new Error('QUOTA_EXCEEDED: Meta rate limit (Reels: 30/day per Page, 100/day per IG account)');
  if (code === 10 || code === 200 || code === 283) throw new Error(`AUTH_META: permission missing (${String(j?.error?.message ?? '').slice(0, 100)}). Add pages_manage_posts / instagram_content_publish in your Meta app and login again`);
  return { status: r.status, j };
}
const form = (o: Record<string, string>) => new URLSearchParams(o);
const fail = (what: string, r: { status: number; j: any }) => new Error(`meta ${what} failed (${r.status}): ${String(r.j?.error?.message ?? JSON.stringify(r.j ?? {})).slice(0, 160)}`);

export const metaPerms = (secrets: SecretStore, which: 'facebook' | 'instagram'): string[] => { try { return secrets.read<{ perms?: string[] }>(which)?.perms ?? []; } catch { return []; } };
export const metaCanPublish = (secrets: SecretStore, platform: string): boolean =>
  platform === 'facebook_reels' ? metaPerms(secrets, 'facebook').includes('pages_manage_posts') : platform === 'instagram_reels' ? metaPerms(secrets, 'instagram').includes('instagram_content_publish') : false;

/** One-time public link for one clip file (Instagram fetches video_url itself). 192-bit token, expires, served without login only for that file. */
export function publicClipLink(store: Store, file: string, base: string): string {
  const t = randomBytes(24).toString('hex'); store.exec(`DELETE FROM kv WHERE k LIKE 'pubfile:%' AND json_extract(v,'$.exp') < ?`, Date.now());
  store.exec(`INSERT INTO kv(k,v) VALUES(?,?)`, `pubfile:${t}`, JSON.stringify({ file, exp: Date.now() + 3 * 3600_000 }));
  return `${base.replace(/\/+$/, '')}/pub/${t}.mp4`;
}
export const isPublicBase = (b: string | undefined): b is string => !!b && /^https:\/\//.test(b) && !/\/\/(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(b);

type Staged = { file: string; title: string; description: string };
const caption = (s: Staged) => `${s.title}\n\n${s.description}`.slice(0, 2200);

export class FacebookReelsAdapter extends StagedAdapter {
  readonly name = 'facebook_reels';
  protected async send(s: Staged): Promise<string> {
    const { page_id: page, access_token: tok } = this.cred as { page_id?: string; access_token?: string }; if (!page || !tok) throw new Error('AUTH_NOT_CONNECTED: Facebook Page login missing');
    const size = (await stat(s.file)).size;
    const st = await call(`${graph()}/${page}/video_reels`, { method: 'POST', body: form({ upload_phase: 'start', access_token: tok }) });
    if (!st.j?.video_id) throw fail('start', st);
    const up = await call(String(st.j.upload_url || `${rupload()}/video-upload/${st.j.video_id}`), { method: 'POST', headers: { authorization: `OAuth ${tok}`, offset: '0', file_size: String(size) }, body: await readFile(s.file), timeoutMs: 600_000 });
    if (!up.j?.success) throw fail('upload', up);
    const fin = await call(`${graph()}/${page}/video_reels`, { method: 'POST', body: form({ upload_phase: 'finish', video_id: String(st.j.video_id), video_state: 'PUBLISHED', description: caption(s), title: s.title.slice(0, 100), access_token: tok }) });
    if (!fin.j?.success) throw fail('finish', fin);
    return `facebook:${st.j.video_id}`;
  }
}

export class InstagramReelsAdapter extends StagedAdapter {
  readonly name = 'instagram_reels';
  protected async send(s: Staged): Promise<string> {
    const { ig_user_id: ig, page_token, access_token } = this.cred as { ig_user_id?: string; page_token?: string; access_token?: string }; const tok = page_token ?? access_token; if (!ig || !tok) throw new Error('AUTH_NOT_CONNECTED: Instagram login missing');
    const base = process.env.PUBLIC_URL; const viaUrl = isPublicBase(base) || process.env.META_ALLOW_HTTP_URL === '1';
    const body: Record<string, string> = { media_type: 'REELS', caption: caption(s), access_token: tok };
    if (viaUrl) body.video_url = publicClipLink(this.store, s.file, base ?? process.env.PUBLIC_URL!); else body.upload_type = 'resumable';
    const c = await call(`${graph()}/${ig}/media`, { method: 'POST', body: form(body) }); const id = c.j?.id; if (!id) throw fail('container', c);
    if (!viaUrl) {
      const size = (await stat(s.file)).size; const up = await call(`${rupload()}/ig-api-upload/${VER}/${id}`, { method: 'POST', headers: { authorization: `OAuth ${tok}`, offset: '0', file_size: String(size) }, body: await readFile(s.file), timeoutMs: 600_000 });
      if (!up.j?.success) throw new Error(`${fail('resumable upload', up).message}. Meta allows resumable only for some apps: set PUBLIC_URL=https://your-server so Instagram can fetch the video instead`);
    }
    for (let i = 0; i < 20; i++) { // docs: poll about once a minute for up to 5 minutes
      const g = await call(`${graph()}/${id}?${form({ fields: 'status_code,status', access_token: tok })}`); const sc = g.j?.status_code;
      if (sc === 'FINISHED') { const pub = await call(`${graph()}/${ig}/media_publish`, { method: 'POST', body: form({ creation_id: String(id), access_token: tok }) }); if (!pub.j?.id) throw fail('media_publish', pub); return `instagram:${pub.j.id}`; }
      if (sc === 'ERROR' || sc === 'EXPIRED') throw new Error(`instagram container ${sc}: ${String(g.j?.status ?? '').slice(0, 120)}`);
      await sleep(pollMs());
    }
    throw new Error('NOT_READY: Instagram is still processing the Reel; retry later');
  }
}
