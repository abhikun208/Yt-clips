import type { Store } from '../db.ts';
import { hourIn, planSlots, type HourStat, type SchedConfig } from './scheduler.ts';

/** Minimal RFC4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; } else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  published_at: ['published_at', 'publishedat', 'video publish time', 'publish time', 'published', 'date', 'datetime'],
  views: ['views', 'view', 'video views'],
  avg_view_pct: ['avg_view_pct', 'average percentage viewed (%)', 'average percentage viewed', 'avg view %'],
  ctr: ['ctr', 'impressions click-through rate (%)', 'click-through rate'],
  platform: ['platform'],
};
const num = (s: string | undefined) => { if (s === undefined) return null; const n = Number(s.replace(/[,%\s]/g, '')); return Number.isFinite(n) && s.trim() !== '' ? n : null; };

export interface ImportResult { imported: number; skipped: { line: number; reason: string }[] }
/**
 * Import rows the OWNER supplies (e.g. a CSV they exported). Needs a timestamp WITH time-of-day and a views number;
 * date-only rows are skipped because they carry no hour information (can't inform an hour-of-day schedule).
 * Re-importing the same (platform, published_at) updates the row (idempotent).
 */
export function importAnalyticsCsv(store: Store, csv: string, defaultPlatform = 'youtube_shorts'): ImportResult {
  const rows = parseCsv(csv); if (rows.length < 2) return { imported: 0, skipped: [{ line: 1, reason: 'no data rows' }] };
  const head = rows[0]!.map((h) => h.trim().toLowerCase()); const idx: Record<string, number> = {};
  for (const [k, names] of Object.entries(ALIASES)) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) idx[k] = i; }
  if (idx.published_at === undefined || idx.views === undefined) throw new Error('invalid CSV: need columns published_at and views');
  const out: ImportResult = { imported: 0, skipped: [] };
  rows.slice(1).forEach((r, n) => {
    const line = n + 2; const when = (r[idx.published_at!] ?? '').trim(); const views = num(r[idx.views!]);
    const t = Date.parse(when);
    if (!when || Number.isNaN(t)) return void out.skipped.push({ line, reason: 'bad published_at' });
    if (!/\d{1,2}:\d{2}/.test(when)) return void out.skipped.push({ line, reason: 'published_at has no time of day' });
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(when)) return void out.skipped.push({ line, reason: 'published_at needs a timezone offset (e.g. 2026-10-01T18:30:00+05:30 or ...Z)' });
    if (views === null || views < 0) return void out.skipped.push({ line, reason: 'bad views' });
    const platform = (idx.platform !== undefined ? (r[idx.platform] ?? '').trim() : '') || defaultPlatform;
    store.exec(`INSERT INTO analytics(platform, published_at, views, avg_view_pct, ctr, note) VALUES (?,?,?,?,?, 'csv')
      ON CONFLICT(platform, published_at) DO UPDATE SET views=excluded.views, avg_view_pct=excluded.avg_view_pct, ctr=excluded.ctr`,
      platform, new Date(t).toISOString(), views, idx.avg_view_pct !== undefined ? num(r[idx.avg_view_pct]) : null, idx.ctr !== undefined ? num(r[idx.ctr]) : null);
    out.imported++;
  });
  return out;
}

/** Hour-of-day evidence from stored analytics rows, bucketed in the owner's timezone. */
export function hourStats(store: Store, tz: string, platform?: string): HourStat[] {
  const rows = store.all<{ published_at: string; views: number }>(platform ? 'SELECT published_at, views FROM analytics WHERE views IS NOT NULL AND platform=?' : 'SELECT published_at, views FROM analytics WHERE views IS NOT NULL', ...(platform ? [platform] : []));
  const m = new Map<number, HourStat>();
  for (const r of rows) { const h = hourIn(tz, new Date(r.published_at)); const s = m.get(h) ?? { hour: h, views: 0, samples: 0 }; s.views += r.views; s.samples++; m.set(h, s); }
  return [...m.values()].sort((a, b) => a.hour - b.hour);
}

/** Plan slots using stored evidence; `basis` says whether it was measured or the baseline. Already-scheduled uploads count toward caps. */
export function planFromStore(store: Store, o: { n: number; tz: string; cfg: SchedConfig; from?: Date; platform?: string }) {
  const existing = store.all<{ scheduled_at: string }>(`SELECT scheduled_at FROM uploads WHERE scheduled_at IS NOT NULL AND state IN ('SCHEDULED_OR_APPROVED','PUBLISHED')`).map((r) => new Date(r.scheduled_at)).filter((d) => !Number.isNaN(d.getTime()));
  const stats = hourStats(store, o.tz, o.platform);
  return { samples: stats.reduce((a, s) => a + s.samples, 0), slots: planSlots(o.n, { from: o.from ?? new Date(), tz: o.tz, cfg: o.cfg, stats, existing }) };
}
