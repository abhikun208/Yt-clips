/**
 * YouTube Studio export -> per-video stats (source MANUAL_IMPORT). The Analytics API may not expose "viewed vs swiped away" or "shown in feed", so the
 * owner exports a CSV from Studio and imports it. Missing columns/cells stay NULL: nothing is estimated or filled in.
 * Also holds the judging rule: a video is only judged when it is old enough AND has enough views, and is only compared with similar videos.
 */
import type { Store } from '../db.ts';
import { parseCsv } from '../schedule/analytics.ts';

const ALIASES: Record<string, string[]> = {
  remote_id: ['content', 'video id', 'video_id', 'id'], title: ['video title', 'title'], published_at: ['video publish time', 'publish time', 'published', 'published_at', 'date published', 'video published'],
  duration_sec: ['duration', 'duration (seconds)'], views: ['views'], engaged_views: ['engaged views'], avg_view_duration_sec: ['average view duration', 'avg view duration', 'average view duration (seconds)'],
  avg_pct_viewed: ['average percentage viewed (%)', 'average percentage viewed', 'avg percentage viewed', 'average view percentage', 'average view percentage (%)'], watch_hours: ['watch time (hours)', 'watch time'],
  likes: ['likes'], comments: ['comments', 'comments added'], shares: ['shares'], subs_gained: ['subscribers gained', 'subscribers', 'new subscribers'], subs_lost: ['subscribers lost'],
  impressions: ['impressions'], viewed_pct: ['viewed (%)', 'viewed vs swiped away (%)', 'stayed to watch (%)', 'stayed to watch', 'viewed'], swiped_pct: ['swiped away (%)', 'swiped away'],
};
const num = (s: string | undefined): number | null => { if (s === undefined) return null; const t = s.replace(/[,%\s]/g, ''); if (t === '' || t === '-') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
/** "0:21", "1:02:03" or plain seconds -> seconds */
export function parseDuration(s: string | undefined): number | null {
  if (s === undefined) return null; const t = s.trim(); if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/); if (!m) return null; return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
const when = (s: string | undefined): string | null => { if (!s || !s.trim()) return null; const t = Date.parse(s.trim()); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

export interface StudioImport { imported: number; skipped: { line: number; reason: string }[]; unmappedColumns: string[]; source: 'MANUAL_IMPORT' }
export function importStudioCsv(store: Store, csv: string): StudioImport {
  const rows = parseCsv(csv); if (rows.length < 2) return { imported: 0, skipped: [{ line: 1, reason: 'no data rows' }], unmappedColumns: [], source: 'MANUAL_IMPORT' };
  const head = rows[0]!.map((h) => h.trim().toLowerCase()); const idx: Record<string, number> = {}; const used = new Set<number>();
  for (const [k, names] of Object.entries(ALIASES)) { const i = head.findIndex((h, j) => names.includes(h) && !used.has(j)); if (i >= 0) { idx[k] = i; used.add(i); } }
  if (idx.remote_id === undefined && idx.title === undefined) throw new Error('invalid Studio CSV: need a "Content" (video id) or "Video title" column');
  if (idx.views === undefined) throw new Error('invalid Studio CSV: need a "Views" column');
  const out: StudioImport = { imported: 0, skipped: [], unmappedColumns: rows[0]!.filter((_, j) => !used.has(j)).map((h) => h.trim()).filter(Boolean), source: 'MANUAL_IMPORT' };
  rows.slice(1).forEach((r, n) => {
    const line = n + 2; if (r.every((c) => !c.trim())) return;
    const g = (k: string) => (idx[k] === undefined ? undefined : r[idx[k]!]); const id = (g('remote_id') ?? '').trim(); const title = (g('title') ?? '').trim();
    if (/^total$/i.test(id) || /^total$/i.test(title)) return void out.skipped.push({ line, reason: 'Total row' });
    const key = id || (title ? `title:${title}` : ''); if (!key) return void out.skipped.push({ line, reason: 'no video id or title' });
    const views = num(g('views')); if (views === null || views < 0) return void out.skipped.push({ line, reason: 'bad views' });
    store.exec(`INSERT INTO studio_stats(remote_id, title, published_at, duration_sec, views, engaged_views, avg_view_duration_sec, avg_pct_viewed, watch_hours, likes, comments, shares, subs_gained, subs_lost, impressions, viewed_pct, swiped_pct, imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
      ON CONFLICT(remote_id) DO UPDATE SET title=excluded.title, published_at=COALESCE(excluded.published_at, published_at), duration_sec=COALESCE(excluded.duration_sec, duration_sec), views=excluded.views, engaged_views=excluded.engaged_views,
        avg_view_duration_sec=excluded.avg_view_duration_sec, avg_pct_viewed=excluded.avg_pct_viewed, watch_hours=excluded.watch_hours, likes=excluded.likes, comments=excluded.comments, shares=excluded.shares,
        subs_gained=excluded.subs_gained, subs_lost=excluded.subs_lost, impressions=excluded.impressions, viewed_pct=excluded.viewed_pct, swiped_pct=excluded.swiped_pct, imported_at=excluded.imported_at`,
      key, title || null, when(g('published_at')), parseDuration(g('duration_sec')), views, num(g('engaged_views')), parseDuration(g('avg_view_duration_sec')), num(g('avg_pct_viewed')), num(g('watch_hours')), num(g('likes')), num(g('comments')), num(g('shares')),
      num(g('subs_gained')), num(g('subs_lost')), num(g('impressions')), num(g('viewed_pct')), num(g('swiped_pct')));
    out.imported++;
  });
  return out;
}

export interface StatRow { remote_id: string; title: string | null; published_at: string | null; duration_sec: number | null; views: number | null; avg_pct_viewed: number | null; viewed_pct: number | null; swiped_pct: number | null; [k: string]: unknown }
export interface JudgeOpts { minAgeHours: number; minViews: number; now?: number }
/** Owner-configurable via kv `analytics:minAgeHours` / `analytics:minViews`; defaults 72 h and 100 views. */
export function judgeOpts(store: Store): JudgeOpts {
  const rd = (k: string, d: number) => { const v = Number(store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v); return Number.isFinite(v) && v >= 0 ? v : d; };
  return { minAgeHours: rd('analytics:minAgeHours', 72), minViews: rd('analytics:minViews', 100) };
}
export type JudgeReason = 'OK' | 'UNKNOWN_AGE' | 'TOO_YOUNG' | 'TOO_FEW_VIEWS';
export function judgeable(r: Pick<StatRow, 'published_at' | 'views'>, o: JudgeOpts): { ok: boolean; reason: JudgeReason; ageHours: number | null } {
  const t = r.published_at ? Date.parse(r.published_at) : NaN; if (Number.isNaN(t)) return { ok: false, reason: 'UNKNOWN_AGE', ageHours: null };
  const age = ((o.now ?? Date.now()) - t) / 3_600_000; if (age < o.minAgeHours) return { ok: false, reason: 'TOO_YOUNG', ageHours: +age.toFixed(1) };
  if (r.views === null || r.views < o.minViews) return { ok: false, reason: 'TOO_FEW_VIEWS', ageHours: +age.toFixed(1) };
  return { ok: true, reason: 'OK', ageHours: +age.toFixed(1) };
}
/** category of our own clip behind a remote video id (uploads -> clips -> candidates.category), or null when unknown */
export function categoryOf(store: Store, remoteId: string): string | null {
  return store.get<{ category: string | null }>(`SELECT c.category FROM uploads u JOIN clips cl ON cl.id=u.clip_id JOIN candidates c ON c.id=cl.candidate_id WHERE u.remote_id=? LIMIT 1`, remoteId)?.category ?? null;
}
/** Peers = judgeable videos of similar age (within ageDays), similar length (within lenRatio) and the same category (when both are known). Never compares across those. */
export function peersOf(store: Store, remoteId: string, o: Partial<JudgeOpts> & { ageDays?: number; lenRatio?: number } = {}): { target: StatRow | null; peers: StatRow[]; excluded: Record<string, number> } {
  const jo = { ...judgeOpts(store), ...o }; const all = store.all<StatRow>('SELECT * FROM studio_stats'); const target = all.find((r) => r.remote_id === remoteId) ?? null;
  const excluded: Record<string, number> = {}; const bump = (k: string) => { excluded[k] = (excluded[k] ?? 0) + 1; }; if (!target) return { target, peers: [], excluded };
  const tCat = categoryOf(store, target.remote_id); const tAge = target.published_at ? Date.parse(target.published_at) : NaN; const ageMs = (o.ageDays ?? 7) * 86_400_000; const lenR = o.lenRatio ?? 0.3; const peers: StatRow[] = [];
  for (const r of all) {
    if (r.remote_id === remoteId) continue; if (!judgeable(r, jo).ok) { bump('not_judgeable'); continue; }
    const age = r.published_at ? Date.parse(r.published_at) : NaN; if (Number.isNaN(tAge) || Math.abs(age - tAge) > ageMs) { bump('different_age'); continue; }
    if (target.duration_sec && r.duration_sec && Math.abs(r.duration_sec - target.duration_sec) / target.duration_sec > lenR) { bump('different_length'); continue; }
    const cat = categoryOf(store, r.remote_id); if (tCat && cat && cat !== tCat) { bump('different_category'); continue; }
    peers.push(r);
  }
  return { target, peers, excluded };
}
