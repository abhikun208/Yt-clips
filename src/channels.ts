import type { Store } from './db.ts';
import type { Config } from './config.ts';
import type { SchedConfig } from './schedule/scheduler.ts';

/** A channel = one brand/account you publish for (e.g. "Team Unknown", "Decider Gaming"). Each has its own schedule policy, caption style, links and platforms. */
export interface ChannelConfig {
  captionPreset?: string; schedule?: Partial<SchedConfig>; platforms?: string[]; links?: { label: string; url: string }[]; hashtags?: string[]; liveUrl?: string; language?: string;
  facecam?: { x: number; y: number; w: number; h: number }; killfeed?: true | { x: number; y: number; w: number; h: number }; translateTo?: 'en' | 'hi' | 'hinglish' | 'auto' | 'original'; cta?: string; disclaimer?: string; layout?: 'auto' | 'gamer_stack' | 'split_gameplay';
}
export interface Channel { id: number; slug: string; name: string; profile: 'general' | 'gaming'; config: ChannelConfig; archived: boolean }
export const MAIN_SLUG = 'main';
export const ALLOWED_PLATFORMS = ['youtube_shorts', 'instagram_reels', 'facebook_reels', 'tiktok', 'telegram', 'discord', 'mastodon', 'x', 'linkedin', 'pinterest', 'snapchat', 'threads', 'bluesky', 'reddit'] as const;
interface Row { id: number; slug: string; name: string; profile: string; config_json: string; archived: number }
const toChannel = (r: Row): Channel => ({ id: r.id, slug: r.slug, name: r.name, profile: r.profile === 'gaming' ? 'gaming' : 'general', config: JSON.parse(r.config_json || '{}') as ChannelConfig, archived: !!r.archived });

export const listChannels = (store: Store, includeArchived = false): Channel[] => store.all<Row>(`SELECT id, slug, name, profile, config_json, archived FROM channels ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY id`).map(toChannel);
export function getChannel(store: Store, ref: number | string | null | undefined): Channel {
  const r = typeof ref === 'number' ? store.get<Row>('SELECT id, slug, name, profile, config_json, archived FROM channels WHERE id=?', ref) : store.get<Row>('SELECT id, slug, name, profile, config_json, archived FROM channels WHERE slug=?', ref || MAIN_SLUG);
  if (!r) throw new Error(`Unknown channel ${ref}`);
  return toChannel(r);
}
export const mainChannel = (store: Store) => getChannel(store, MAIN_SLUG);

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40);

/** Validates and normalises owner input. Throws `invalid: ...` (HTTP 400). Never accepts arbitrary keys. */
export function cleanConfig(c: unknown, presetOk: (id: string) => boolean): ChannelConfig {
  if (c === undefined || c === null) return {}; if (typeof c !== 'object' || Array.isArray(c)) throw new Error('invalid: config must be an object');
  const i = c as Record<string, unknown>; const o: ChannelConfig = {};
  const known = new Set(['captionPreset', 'schedule', 'platforms', 'links', 'hashtags', 'liveUrl', 'language', 'facecam', 'killfeed', 'translateTo', 'layout', 'cta', 'disclaimer']); for (const k of Object.keys(i)) if (!known.has(k)) throw new Error(`invalid: unknown channel setting ${k}`);
  if (i.captionPreset !== undefined) { if (typeof i.captionPreset !== 'string' || (i.captionPreset !== 'none' && !presetOk(i.captionPreset))) throw new Error('invalid: unknown caption preset'); o.captionPreset = i.captionPreset; }
  if (i.platforms !== undefined) { const ok = ALLOWED_PLATFORMS as readonly string[]; if (!Array.isArray(i.platforms) || i.platforms.some((p) => !ok.includes(String(p)))) throw new Error('invalid: platforms'); o.platforms = i.platforms.map(String); }
  if (i.links !== undefined) { if (!Array.isArray(i.links) || i.links.length > 8) throw new Error('invalid: links (max 8)'); o.links = i.links.map((l) => { const x = l as { label?: unknown; url?: unknown }; if (typeof x.label !== 'string' || typeof x.url !== 'string' || !/^https:\/\/[^\s]{3,300}$/.test(x.url) || x.label.length > 40) throw new Error('invalid: link needs label and https url'); return { label: x.label, url: x.url }; }); }
  if (i.hashtags !== undefined) { if (!Array.isArray(i.hashtags) || i.hashtags.length > 8 || i.hashtags.some((h) => typeof h !== 'string' || !/^#[\p{L}\p{N}_]{1,30}$/u.test(h))) throw new Error('invalid: hashtags like #freefire (max 8)'); o.hashtags = i.hashtags.map(String); }
  if (i.liveUrl !== undefined) { if (typeof i.liveUrl !== 'string' || !/^https:\/\/[^\s]{3,300}$/.test(i.liveUrl)) throw new Error('invalid: liveUrl must be https'); o.liveUrl = i.liveUrl; }
  if (i.language !== undefined) { if (typeof i.language !== 'string' || !/^[a-z]{2,3}$/.test(i.language)) throw new Error('invalid: language code'); o.language = i.language; }
  if (i.disclaimer !== undefined) { if (typeof i.disclaimer !== 'string' || i.disclaimer.length > 300) throw new Error('invalid: disclaimer must be text up to 300 chars'); o.disclaimer = i.disclaimer; }
  if (i.cta !== undefined) { if (typeof i.cta !== 'string' || i.cta.length > 40) throw new Error('invalid: cta must be text up to 40 chars'); o.cta = i.cta; }
  if (i.layout !== undefined) { if (i.layout !== 'auto' && i.layout !== 'gamer_stack' && i.layout !== 'split_gameplay') throw new Error('invalid: layout'); o.layout = i.layout; }
  if (i.facecam !== undefined) { const f = i.facecam as Record<string, unknown>; const n = ['x', 'y', 'w', 'h'].map((k) => Number(f?.[k])); if (n.some((v) => !(v >= 0 && v <= 1)) || n[0]! + n[2]! > 1.001 || n[1]! + n[3]! > 1.001 || n[2]! < 0.05 || n[3]! < 0.05) throw new Error('invalid: facecam must be fractions {x,y,w,h} inside the frame'); o.facecam = { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! }; }
  if (i.killfeed !== undefined) { if (i.killfeed === true) o.killfeed = true; else { const f = i.killfeed as Record<string, unknown>; const n = ['x', 'y', 'w', 'h'].map((k) => Number(f?.[k])); if (n.some((v) => !(v >= 0 && v <= 1)) || n[0]! + n[2]! > 1.001 || n[1]! + n[3]! > 1.001 || n[2]! < 0.05 || n[3]! < 0.05) throw new Error('invalid: killfeed must be true or {x,y,w,h} fractions inside the frame'); o.killfeed = { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! }; } }
  if (i.translateTo !== undefined) { if (!['en', 'hi', 'hinglish', 'auto', 'original'].includes(i.translateTo as string)) throw new Error('invalid: translateTo must be hinglish, hi, en, auto or original'); o.translateTo = i.translateTo as NonNullable<ChannelConfig['translateTo']>; }
  if (i.schedule !== undefined) {
    const s = i.schedule as Record<string, unknown>; const out: Partial<SchedConfig> = {};
    const int = (v: unknown, lo: number, hi: number, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`invalid: schedule.${name} must be ${lo}-${hi}`); return n; };
    for (const k of Object.keys(s)) if (!['perDayCap', 'minGapMinutes', 'quietHours', 'baselineHours', 'jitterMinutes', 'staggerMinutes'].includes(k)) throw new Error(`invalid: unknown schedule setting ${k}`);
    if (s.perDayCap !== undefined) out.perDayCap = int(s.perDayCap, 1, 20, 'perDayCap');
    if (s.minGapMinutes !== undefined) out.minGapMinutes = int(s.minGapMinutes, 15, 24 * 60, 'minGapMinutes');
    if (s.staggerMinutes !== undefined) out.staggerMinutes = int(s.staggerMinutes, 0, 720, 'staggerMinutes');
    if (s.jitterMinutes !== undefined) out.jitterMinutes = int(s.jitterMinutes, 0, 120, 'jitterMinutes');
    if (s.quietHours !== undefined) { if (!Array.isArray(s.quietHours) || s.quietHours.length !== 2) throw new Error('invalid: schedule.quietHours [from,to]'); out.quietHours = [int(s.quietHours[0], 0, 23, 'quietHours'), int(s.quietHours[1], 0, 23, 'quietHours')]; }
    if (s.baselineHours !== undefined) { if (!Array.isArray(s.baselineHours) || !s.baselineHours.length || s.baselineHours.length > 12) throw new Error('invalid: schedule.baselineHours'); out.baselineHours = [...new Set(s.baselineHours.map((h) => int(h, 0, 23, 'baselineHours')))].sort((a, b) => a - b); }
    o.schedule = out;
  }
  return o;
}

export function createChannel(store: Store, v: { name: string; profile?: string; config?: unknown }, presetOk: (id: string) => boolean): Channel {
  const name = String(v.name ?? '').trim(); if (name.length < 2 || name.length > 60) throw new Error('invalid: channel name 2-60 chars');
  const profile = v.profile === 'gaming' ? 'gaming' : 'general'; let slug = slugify(name) || 'channel'; if (slug === MAIN_SLUG) slug = 'main-2';
  const base = slug; for (let n = 2; store.get('SELECT 1 FROM channels WHERE slug=?', slug); n++) slug = `${base}-${n}`;
  const cfg = cleanConfig(v.config, presetOk); const r = store.exec('INSERT INTO channels(slug, name, profile, config_json) VALUES (?,?,?,?)', slug, name, profile, JSON.stringify(cfg));
  store.logState('channel', r.lastId, null, 'created', name); return getChannel(store, r.lastId);
}
export function updateChannel(store: Store, id: number, v: { name?: string; profile?: string; config?: unknown; archived?: boolean }, presetOk: (id: string) => boolean): Channel {
  const cur = getChannel(store, id);
  const name = v.name !== undefined ? String(v.name).trim() : cur.name; if (name.length < 2 || name.length > 60) throw new Error('invalid: channel name 2-60 chars');
  const profile = v.profile !== undefined ? (v.profile === 'gaming' ? 'gaming' : 'general') : cur.profile;
  const cfg = v.config !== undefined ? { ...cur.config, ...cleanConfig(v.config, presetOk) } : cur.config;
  if (cfg.schedule && v.config && (v.config as { schedule?: unknown }).schedule) cfg.schedule = { ...cur.config.schedule, ...cfg.schedule };
  if (v.archived && cur.slug === MAIN_SLUG) throw new Error('invalid: the main channel cannot be archived');
  store.exec('UPDATE channels SET name=?, profile=?, config_json=?, archived=? WHERE id=?', name, profile, JSON.stringify(cfg), v.archived === undefined ? (cur.archived ? 1 : 0) : v.archived ? 1 : 0, id);
  store.logState('channel', id, null, 'updated', name); return getChannel(store, id);
}

/** Channel a video belongs to (via its source). Falls back to main. */
export function channelOfVideo(store: Store, videoId: number): Channel {
  const r = store.get<{ channel_id: number | null }>('SELECT s.channel_id FROM videos v LEFT JOIN sources s ON s.id=v.source_id WHERE v.id=?', videoId);
  return r?.channel_id ? getChannel(store, r.channel_id) : mainChannel(store);
}
export function channelOfClip(store: Store, clipId: number): Channel {
  const r = store.get<{ video_id: number }>('SELECT cd.video_id FROM clips c JOIN candidates cd ON cd.id=c.candidate_id WHERE c.id=?', clipId);
  return r ? channelOfVideo(store, r.video_id) : mainChannel(store);
}
/** The channel's effective schedule policy = global config overlaid with the channel's own settings. */
export const scheduleFor = (cfg: Config, ch: Channel): SchedConfig => ({ ...cfg.schedule, ...(ch.config.schedule ?? {}) });
/** Secret-store name for a channel's YouTube token. `main` keeps the legacy name `youtube` (existing connections keep working). */
export const ytSecretName = (ch: Pick<Channel, 'slug'>) => (ch.slug === MAIN_SLUG ? 'youtube' : `youtube-${ch.slug}`);
