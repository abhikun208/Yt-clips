import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { listChannels, ytSecretName, MAIN_SLUG } from '../channels.ts';
import { secretsFor } from '../publish/service.ts';
import { identityOf } from '../publish/webauth.ts';

/**
 * Connected Accounts registry. One row per PUBLISHING DESTINATION (a YouTube channel, a Facebook Page, an Instagram professional account,
 * a TikTok account) with a stable id (`yt:<channelId>`, `fb:<pageId>`, `ig:<igUserId>`, `tt:<openId>`), independent of which Google/Meta/TikTok
 * login produced it. The row only POINTS at the encrypted secret (`secret_ref`); no token is ever stored here or returned by any API.
 * Rows are upserted by id, never replaced wholesale, so adding/reconnecting one account cannot touch another. `status` is derived from evidence
 * (does the secret hold a usable token?), `enabled` is the owner's switch and survives reconnects.
 */
export type DestPlatform = 'youtube' | 'facebook' | 'instagram' | 'tiktok';
export type DestStatus = 'connected' | 'unverified' | 'expired' | 'disconnected';
export interface Destination { id: string; platform: DestPlatform; externalId: string; name: string; thumb: string | null; channelSlug: string | null; secretRef: string; status: DestStatus; enabled: boolean; lastUploadAt: string | null; verifiedAt: string | null; createdAt: string; warnings: string[] }
interface Row { id: string; platform: string; external_id: string; name: string; thumb: string | null; channel_slug: string | null; secret_ref: string; status: string; enabled: number; created_at: string; meta_json: string }

/** upload platform id (queue) -> destination platform */
export const destPlatformOf = (uploadPlatform: string): DestPlatform | null => uploadPlatform === 'youtube_shorts' || uploadPlatform === 'youtube' ? 'youtube' : uploadPlatform === 'facebook_reels' ? 'facebook' : uploadPlatform === 'instagram_reels' ? 'instagram' : uploadPlatform === 'tiktok' ? 'tiktok' : null;

function upsert(store: Store, d0: { id: string; platform: DestPlatform; externalId: string; name: string; thumb?: string | null; channelSlug: string | null; secretRef: string; status: DestStatus; meta?: Record<string, unknown> }): void {
  const d = { ...d0 }; if (d.platform !== 'youtube') { const old = store.get<{ meta_json: string }>('SELECT meta_json FROM destinations WHERE id=?', d.id); const v = old ? (JSON.parse(old.meta_json || '{}') as { verifiedAt?: string }).verifiedAt : undefined; if (v && !d.meta?.verifiedAt) d.meta = { ...d.meta, verifiedAt: v }; }
  store.exec(`INSERT INTO destinations(id, platform, external_id, name, thumb, channel_slug, secret_ref, status, meta_json) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, thumb=COALESCE(excluded.thumb, destinations.thumb), channel_slug=excluded.channel_slug, secret_ref=excluded.secret_ref, status=excluded.status, meta_json=excluded.meta_json, updated_at=datetime('now')`,
    d.id, d.platform, d.externalId, d.name, d.thumb ?? null, d.channelSlug, d.secretRef, d.status, JSON.stringify(d.meta ?? {}));
}
export const healthName = (id: string): string => `health-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
const rd = <T extends Record<string, unknown>>(cfg: Config, name: string): T | null => { try { return secretsFor(cfg).read<T>(name); } catch { return null; } };

/**
 * Re-derives the registry from what is actually connected. Idempotent and additive: it never deletes a row (history stays) and never changes
 * `enabled`. A row whose secret has no usable token becomes `disconnected`.
 */
export function syncDestinations(store: Store, cfg: Config): void {
  const seen = new Set<string>();
  const mark = (id: string) => seen.add(id);
  // YouTube: one destination per connected channel slug, keyed by the verified YouTube channel id
  const byChan = new Map<string, string[]>();
  for (const ch of listChannels(store, true)) {
    const ref = ytSecretName(ch); const t = rd<{ refresh_token?: string }>(cfg, ref); if (!t?.refresh_token) continue;
    const ident = identityOf(store, ch.slug);
    const id = ident ? `yt:${ident.channelId}` : `yt:slug:${ch.slug}`;
    if (ident) { store.exec('DELETE FROM destinations WHERE id=? AND NOT EXISTS (SELECT 1 FROM uploads WHERE destination_id=destinations.id)', `yt:slug:${ch.slug}`); }
    const l = byChan.get(id) ?? []; l.push(ch.slug); byChan.set(id, l);
    if (l.length > 1) continue; // duplicate of an already-registered channel: first slug stays the owner of the row
    upsert(store, { id, platform: 'youtube', externalId: ident?.channelId ?? `slug:${ch.slug}`, name: ident?.title ?? ch.name, thumb: ident?.thumb ?? null, channelSlug: ch.slug, secretRef: ref, status: rd<{ bad?: string }>(cfg, `${ref}-health`)?.bad ? 'expired' : ident ? 'connected' : 'unverified', meta: { ...(ident?.at ? { verifiedAt: ident.at } : {}) } });
    mark(id);
  }
  for (const [id, slugs] of byChan) if (slugs.length > 1) store.exec(`UPDATE destinations SET meta_json=json_set(meta_json,'$.duplicateSlugs',json(?)) WHERE id=?`, JSON.stringify(slugs.slice(1)), id);
  // Meta: every Page (and its Instagram) from any Meta login; per-channel overrides say which channel publishes where
  const mp = rd<{ pages?: { id: string; name: string; ig_user_id: string | null }[] }>(cfg, 'meta-pages'); const assigned = new Map<string, string>(); const igAssigned = new Map<string, string>();
  for (const ch of listChannels(store, true)) { const f = rd<{ page_id?: string }>(cfg, `facebook-${ch.slug}`); if (f?.page_id) assigned.set(f.page_id, ch.slug); const i = rd<{ ig_user_id?: string }>(cfg, `instagram-${ch.slug}`); if (i?.ig_user_id) igAssigned.set(i.ig_user_id, ch.slug); }
  const defFb = rd<{ page_id?: string; page_name?: string; access_token?: string }>(cfg, 'facebook'); const defIg = rd<{ ig_user_id?: string; access_token?: string }>(cfg, 'instagram');
  const pages = [...(mp?.pages ?? [])]; if (defFb?.access_token && defFb.page_id && !pages.some((p) => p.id === defFb.page_id)) pages.push({ id: defFb.page_id, name: defFb.page_name ?? `Page ${defFb.page_id}`, ig_user_id: null });
  for (const p of pages) {
    const slug = assigned.get(p.id) ?? (defFb?.page_id === p.id ? MAIN_SLUG : null);
    upsert(store, { id: `fb:${p.id}`, platform: 'facebook', externalId: p.id, name: p.name, channelSlug: slug, secretRef: mp?.pages?.some((x) => x.id === p.id) ? `meta-pages#${p.id}` : 'facebook', status: 'connected' }); mark(`fb:${p.id}`);
    if (p.ig_user_id) { upsert(store, { id: `ig:${p.ig_user_id}`, platform: 'instagram', externalId: p.ig_user_id, name: `${p.name} (Instagram)`, channelSlug: igAssigned.get(p.ig_user_id) ?? (defIg?.ig_user_id === p.ig_user_id ? MAIN_SLUG : null), secretRef: `meta-pages#${p.id}`, status: 'connected', meta: { pageId: p.id } }); mark(`ig:${p.ig_user_id}`); }
  }
  if (defIg?.access_token && defIg.ig_user_id && !seen.has(`ig:${defIg.ig_user_id}`)) { upsert(store, { id: `ig:${defIg.ig_user_id}`, platform: 'instagram', externalId: defIg.ig_user_id, name: `Instagram ${defIg.ig_user_id}`, channelSlug: MAIN_SLUG, secretRef: 'instagram', status: 'connected' }); mark(`ig:${defIg.ig_user_id}`); }
  // TikTok: default secret + every registered tiktok-<openId> secret
  const ttRefs = new Set<string>(['tiktok', ...secretsFor(cfg).names('tiktok-')]);
  for (const ref of ttRefs) {
    const t = rd<{ access_token?: string; open_id?: string; expires_at?: number; refresh_expires_at?: number; display_name?: string }>(cfg, ref); if (!t?.access_token || !t.open_id) continue;
    const refreshDead = !!t.refresh_expires_at && t.refresh_expires_at < Date.now(); const accessDead = !!t.expires_at && t.expires_at < Date.now();
    upsert(store, { id: `tt:${t.open_id}`, platform: 'tiktok', externalId: t.open_id, name: t.display_name ?? `TikTok ${t.open_id.slice(-6)}`, channelSlug: store.get<{ channel_slug: string | null }>('SELECT channel_slug FROM destinations WHERE id=?', `tt:${t.open_id}`)?.channel_slug ?? MAIN_SLUG, secretRef: ref, status: refreshDead ? 'expired' : accessDead && !(t as { refresh_token?: string }).refresh_token ? 'expired' : 'connected' }); mark(`tt:${t.open_id}`);
  }
  for (const r of store.all<{ id: string }>(`SELECT id FROM destinations WHERE platform!='youtube' AND status='connected'`)) if (seen.has(r.id) && rd<{ bad?: string }>(cfg, healthName(r.id))?.bad) store.exec(`UPDATE destinations SET status='expired' WHERE id=?`, r.id);
  // anything registered earlier whose evidence is gone is disconnected (row + history stay; other rows untouched)
  for (const r of store.all<{ id: string }>(`SELECT id FROM destinations WHERE status!='disconnected'`)) if (!seen.has(r.id)) store.exec(`UPDATE destinations SET status='disconnected', updated_at=datetime('now') WHERE id=?`, r.id);
}

export function listDestinations(store: Store, cfg: Config): Destination[] {
  syncDestinations(store, cfg);
  return store.all<Row>('SELECT * FROM destinations ORDER BY platform, created_at, id').map((r) => {
    const meta = JSON.parse(r.meta_json || '{}') as { duplicateSlugs?: string[] };
    const last = store.get<{ t: string | null }>(`SELECT MAX(updated_at) AS t FROM uploads WHERE state IN ('PUBLISHED','ANALYTICS_WAIT','ANALYZING','LEARNING','NEXT_CYCLE') AND (destination_id=? OR (destination_id IS NULL AND platform IN (?,?) AND channel_id=(SELECT id FROM channels WHERE slug=?)))`, r.id, ...(r.platform === 'youtube' ? ['youtube_shorts', 'youtube'] : [r.platform === 'facebook' ? 'facebook_reels' : r.platform === 'instagram' ? 'instagram_reels' : 'tiktok', '-']), r.channel_slug ?? '')?.t ?? null;
    return { id: r.id, platform: r.platform as DestPlatform, externalId: r.external_id, name: r.name, thumb: r.thumb, channelSlug: r.channel_slug, secretRef: r.secret_ref.replace(/#.*/, ''), status: r.status as DestStatus, enabled: !!r.enabled, lastUploadAt: last, verifiedAt: (meta as { verifiedAt?: string }).verifiedAt ?? null, createdAt: r.created_at, warnings: meta.duplicateSlugs?.length ? [`Ye YouTube channel ${meta.duplicateSlugs.length + 1} jagah connected hai (${meta.duplicateSlugs.join(', ')}) — ek hi rakho`] : [] };
  });
}

export function setDestinationEnabled(store: Store, id: string, enabled: boolean): void {
  if (!store.get('SELECT 1 FROM destinations WHERE id=?', id)) throw new Error('invalid: unknown account');
  store.exec(`UPDATE destinations SET enabled=?, updated_at=datetime('now') WHERE id=?`, enabled ? 1 : 0, id); store.logState('destination', 0, null, enabled ? 'enabled' : 'disabled', id);
}

/** Disconnects exactly ONE destination: removes only the credential that belongs to it. Other accounts (even on the same login) keep working. */
export function disconnectDestination(store: Store, cfg: Config, id: string): void {
  syncDestinations(store, cfg);
  const r = store.get<Row>('SELECT * FROM destinations WHERE id=?', id); if (!r) throw new Error('invalid: unknown account');
  const sec = secretsFor(cfg);
  if (r.platform === 'youtube') { // the account, wherever it is stored: its own slug AND any duplicate slug holding the same channel
    const dups = (JSON.parse(r.meta_json || '{}') as { duplicateSlugs?: string[] }).duplicateSlugs ?? [];
    sec.delete(r.secret_ref); if (r.channel_slug) store.exec('DELETE FROM kv WHERE k=?', `ytinfo:${r.channel_slug}`);
    for (const slug of dups) { try { sec.delete(slug === 'main' ? 'youtube' : `youtube-${slug}`); } catch { /* none */ } store.exec('DELETE FROM kv WHERE k=?', `ytinfo:${slug}`); }
  }
  else if (r.platform === 'tiktok') sec.delete(r.secret_ref);
  else {
    const pid = r.platform === 'facebook' ? r.external_id : (JSON.parse(r.meta_json || '{}') as { pageId?: string }).pageId;
    const mp = rd<{ pages?: { id: string; ig_user_id: string | null }[] } & Record<string, unknown>>(cfg, 'meta-pages');
    if (r.platform === 'facebook') {
      if (mp?.pages) sec.write('meta-pages', { ...mp, pages: mp.pages.filter((p) => p.id !== pid) });
      for (const ch of listChannels(store, true)) { const f = rd<{ page_id?: string }>(cfg, `facebook-${ch.slug}`); if (f?.page_id === pid) sec.delete(`facebook-${ch.slug}`); }
      if (rd<{ page_id?: string }>(cfg, 'facebook')?.page_id === pid) sec.delete('facebook');
    }
    // Instagram: only the Instagram link is cut; the Page stays usable
    for (const p of mp?.pages ?? []) if (p.id === pid && (r.platform === 'instagram')) { sec.write('meta-pages', { ...mp, pages: mp!.pages!.map((x) => (x.id === pid ? { ...x, ig_user_id: null } : x)) }); }
    if (r.platform === 'instagram') { for (const ch of listChannels(store, true)) { if (rd<{ ig_user_id?: string }>(cfg, `instagram-${ch.slug}`)?.ig_user_id === r.external_id) sec.delete(`instagram-${ch.slug}`); } if (rd<{ ig_user_id?: string }>(cfg, 'instagram')?.ig_user_id === r.external_id) sec.delete('instagram'); }
    else { const ig = (mp?.pages ?? []).find((p) => p.id === pid)?.ig_user_id; if (ig) { for (const ch of listChannels(store, true)) if (rd<{ page_token?: string; ig_user_id?: string }>(cfg, `instagram-${ch.slug}`)?.ig_user_id === ig) sec.delete(`instagram-${ch.slug}`); } }
  }
  store.exec(`UPDATE destinations SET status='disconnected', updated_at=datetime('now') WHERE id=?`, id); store.logState('destination', 0, null, 'disconnected', id);
  syncDestinations(store, cfg);
}

/** Removes ONLY the duplicate slugs' copies of a YouTube channel (the destination's own slug stays connected). Returns the slugs cleaned. */
export function dedupeDestination(store: Store, cfg: Config, id: string): string[] {
  syncDestinations(store, cfg);
  const r = store.get<Row>('SELECT * FROM destinations WHERE id=?', id); if (!r || r.platform !== 'youtube') throw new Error('invalid: unknown YouTube account');
  const dups = (JSON.parse(r.meta_json || '{}') as { duplicateSlugs?: string[] }).duplicateSlugs ?? []; const sec = secretsFor(cfg);
  for (const slug of dups) { try { sec.delete(slug === 'main' ? 'youtube' : `youtube-${slug}`); } catch { /* none */ } store.exec('DELETE FROM kv WHERE k=?', `ytinfo:${slug}`); }
  store.exec(`UPDATE destinations SET meta_json=json_remove(meta_json,'$.duplicateSlugs') WHERE id=?`, id); store.logState('destination', 0, null, 'dedupe', id);
  syncDestinations(store, cfg); return dups;
}

/** The destination a channel publishes to on a platform (null = none registered yet). Used to gate the queue and to label uploads. */
export function destinationFor(store: Store, cfg: Config, channelSlug: string, uploadPlatform: string): Destination | null {
  const p = destPlatformOf(uploadPlatform); if (!p) return null;
  const all = listDestinations(store, cfg).filter((d) => d.platform === p);
  const own = all.filter((d) => d.channelSlug === channelSlug && d.status !== 'disconnected'); if (own.length) return own[0]!;
  if (p === 'youtube') return null; // YouTube is strictly per channel; never fall back to another channel's account
  return channelSlug === MAIN_SLUG ? null : all.find((d) => d.channelSlug === MAIN_SLUG && d.status !== 'disconnected') ?? null; // Meta/TikTok: channel without its own override uses the default account
}
/** Reason a publish step must not run, or null. A disabled destination blocks ONLY its own uploads. */
export function destinationBlock(store: Store, cfg: Config, channelSlug: string, uploadPlatform: string): string | null {
  const d = destinationFor(store, cfg, channelSlug, uploadPlatform); if (!d) return null;
  return d.enabled ? null : `DESTINATION_DISABLED: ${d.name} (${d.platform}) band hai — Connected Accounts me Enable karo`;
}
/** Remember which destination an upload went to (per-account history). Set once. */
export function stampUpload(store: Store, cfg: Config, uploadId: number, channelSlug: string, uploadPlatform: string): void {
  const d = destinationFor(store, cfg, channelSlug, uploadPlatform); if (d) store.exec('UPDATE uploads SET destination_id=? WHERE id=? AND destination_id IS NULL', d.id, uploadId);
}

export interface SourceMapping { sourceId: number; channelId: number; platform: string; enabled: boolean; priority: number }
/** Extra destinations of a source (besides the channel the source belongs to). */
export function listSourceMappings(store: Store, sourceId?: number): SourceMapping[] {
  return store.all<{ source_id: number; channel_id: number; platform: string; enabled: number; priority: number }>(`SELECT * FROM source_destinations ${sourceId ? 'WHERE source_id=?' : ''} ORDER BY priority DESC, channel_id`, ...(sourceId ? [sourceId] : []))
    .map((r) => ({ sourceId: r.source_id, channelId: r.channel_id, platform: r.platform, enabled: !!r.enabled, priority: r.priority }));
}
export function setSourceMapping(store: Store, m: { sourceId: number; channelId: number; platform?: string; enabled?: boolean; priority?: number; remove?: boolean }): void {
  const src = store.get<{ channel_id: number | null }>('SELECT channel_id FROM sources WHERE id=?', m.sourceId); if (!src) throw new Error('not found: source');
  if (!store.get('SELECT 1 FROM channels WHERE id=?', m.channelId)) throw new Error('not found: channel');
  const platform = m.platform ?? 'youtube_shorts';
  if (m.remove) { store.exec('DELETE FROM source_destinations WHERE source_id=? AND channel_id=? AND platform=?', m.sourceId, m.channelId, platform); return; }
  if (src.channel_id === m.channelId) throw new Error('invalid: ye source ka apna channel hai (wo already default destination hai)');
  store.exec(`INSERT INTO source_destinations(source_id, channel_id, platform, enabled, priority) VALUES (?,?,?,?,?) ON CONFLICT(source_id, channel_id, platform) DO UPDATE SET enabled=excluded.enabled, priority=excluded.priority`, m.sourceId, m.channelId, platform, m.enabled === false ? 0 : 1, m.priority ?? 0);
}

/** Real "Test connection" for a YouTube account: refreshes the token and asks Google who it is, compares with the registered channel. Never fakes success. */
export async function testDestination(store: Store, cfg: Config, id: string): Promise<{ ok: boolean; status: string; message: string; identity?: { id: string; title: string } }> {
  syncDestinations(store, cfg);
  const r = store.get<Row>('SELECT * FROM destinations WHERE id=?', id); if (!r) throw new Error('not found: account');
  if (r.platform !== 'youtube') return testSocial(store, cfg, r);
  const ch = listChannels(store, true).find((c) => c.slug === r.channel_slug); if (!ch) return { ok: false, status: 'disconnected', message: 'channel nahi mila' };
  const { YouTubeAdapter } = await import('../publish/youtube.ts'); const { tokenFor } = await import('../publish/service.ts');
  try {
    const me = await new YouTubeAdapter(store, tokenFor(cfg, ch)).whoami();
    if (!me) return { ok: false, status: 'unverified', message: 'Login chal gaya par is Google account par YouTube channel nahi hai' };
    const want = r.external_id.startsWith('slug:') ? null : r.external_id;
    if (want && me.id !== want) return { ok: false, status: 'mismatch', message: `Is login ka channel ${me.title} (${me.id}) hai, registered ${want} nahi — upload block rahega. Reconnect karo.`, identity: { id: me.id, title: me.title } };
    store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `ytinfo:${ch.slug}`, JSON.stringify({ ...(identityOf(store, ch.slug) ?? {}), channelId: me.id, title: me.title, at: new Date().toISOString() }));
    syncDestinations(store, cfg); return { ok: true, status: 'connected', message: `✓ Google ne confirm kiya: ${me.title}`, identity: { id: me.id, title: me.title } };
  } catch (e) { const m = String((e as Error).message); syncDestinations(store, cfg); return { ok: false, status: /AUTH_/.test(m) ? 'expired' : 'error', message: m.slice(0, 220) }; }
}

type TestRes = { ok: boolean; status: string; message: string; identity?: { id: string; title: string } };
/** Real "Test connection" for Facebook Page / Instagram / TikTok: asks the provider who the token belongs to. Never fakes success. */
async function testSocial(store: Store, cfg: Config, r: Row): Promise<TestRes> {
  const [name, sub] = r.secret_ref.split('#'); const sec = rd<Record<string, unknown>>(cfg, name!);
  if (!sec) return { ok: false, status: 'disconnected', message: 'token nahi mila — reconnect karo' };
  const hn = healthName(r.id); const mark = (bad: string | null) => { try { const s = secretsFor(cfg); if (bad) s.write(hn, { bad, at: new Date().toISOString() }); else s.delete(hn); } catch { /* best effort */ } };
  let url: string; const headers: Record<string, string> = {};
  if (r.platform === 'tiktok') {
    const tok = sec.access_token as string | undefined; if (!tok) return { ok: false, status: 'disconnected', message: 'token nahi mila — reconnect karo' };
    url = `${process.env.TIKTOK_API_BASE ?? 'https://open.tiktokapis.com'}/v2/user/info/?fields=open_id,display_name`; headers.authorization = `Bearer ${tok}`;
  } else {
    const page = sub ? (sec.pages as { id: string; access_token?: string }[] | undefined)?.find((p) => p.id === sub) : undefined;
    const tok = (page?.access_token ?? sec.access_token ?? sec.page_token) as string | undefined; if (!tok) return { ok: false, status: 'disconnected', message: 'token nahi mila — reconnect karo' };
    const id = r.platform === 'instagram' && r.secret_ref.includes('#') ? r.external_id : r.external_id;
    url = `${process.env.GRAPH_API_BASE ?? 'https://graph.facebook.com/v26.0'}/${encodeURIComponent(id)}?fields=id,name&access_token=${encodeURIComponent(tok)}`;
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); const txt = await res.text(); let j: any = {}; try { j = JSON.parse(txt); } catch { /* */ }
    const code = j?.error?.code; const rejected = res.status === 401 || code === 190 || /expired|invalid.*token|access_token/i.test(String(j?.error?.message ?? j?.error?.code ?? ''));
    if (!res.ok || j?.error?.code && j.error.code !== 'ok') {
      if (rejected) { mark('token rejected'); syncDestinations(store, cfg); return { ok: false, status: 'expired', message: `${r.platform} ne token reject kiya — reconnect karo` }; }
      return { ok: false, status: 'error', message: `${r.platform} error ${res.status}: ${String(j?.error?.message ?? txt).slice(0, 160)}` };
    }
    const got = r.platform === 'tiktok' ? (j?.data?.user?.open_id as string | undefined) : (j?.id as string | undefined);
    const title = String(r.platform === 'tiktok' ? j?.data?.user?.display_name ?? r.name : j?.name ?? r.name);
    if (got && got !== r.external_id) return { ok: false, status: 'mismatch', message: `Is token ka account ${title} (${got}) hai, registered ${r.external_id} nahi — upload block rahega.`, identity: { id: got, title } };
    mark(null); store.exec(`UPDATE destinations SET status='connected', meta_json=json_set(meta_json,'$.verifiedAt',?) WHERE id=?`, new Date().toISOString(), r.id);
    return { ok: true, status: 'connected', message: `✓ ${r.platform} ne confirm kiya: ${title}`, identity: { id: r.external_id, title } };
  } catch (e) { return { ok: false, status: 'error', message: String((e as Error).message).slice(0, 200) }; }
}
