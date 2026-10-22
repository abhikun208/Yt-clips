import type { Store } from '../db.ts';
import type { Provider } from './providers.ts';
import { warn } from '../util/log.ts';

export interface CollectResult { platform: string; requested: number; recorded: number; error?: string }

/**
 * Read-only collection for uploads that are actually PUBLISHED. Each fetch appends a snapshot row (history kept) and upserts the
 * per-publish-time row the scheduler learns from (latest views win). A platform with no token/ids is skipped; one platform failing
 * never blocks the others. Nothing is fabricated: items the platform does not return are simply not recorded.
 */
export async function collectAnalytics(store: Store, providers: Provider[]): Promise<CollectResult[]> {
  const res: CollectResult[] = [];
  for (const p of providers) {
    const ups = store.all<{ remote_id: string; updated_at: string }>(`SELECT remote_id, updated_at FROM uploads WHERE state IN ('PUBLISHED','ANALYTICS_WAIT','ANALYZING','LEARNING','NEXT_CYCLE') AND remote_id IS NOT NULL AND platform=?`, p.platform);
    if (!ups.length || !p.connected()) { res.push({ platform: p.platform, requested: 0, recorded: 0 }); continue; }
    try {
      const stats = await p.fetch(ups.map((u) => u.remote_id)); let n = 0;
      for (const s of stats) {
        store.exec(`INSERT INTO analytics_snapshots(platform, remote_id, published_at, views, likes, comments, shares, saves, reach, avg_watch_sec) VALUES (?,?,?,?,?,?,?,?,?,?)`, p.platform, s.remoteId, s.publishedAt, s.views, s.likes ?? null, s.comments ?? null, s.shares ?? null, s.saves ?? null, s.reach ?? null, s.avgWatchSec ?? null);
        if (s.publishedAt && s.views != null) store.exec(`INSERT INTO analytics(platform, published_at, views, note) VALUES (?,?,?, 'api') ON CONFLICT(platform, published_at) DO UPDATE SET views=excluded.views`, p.platform, s.publishedAt, s.views);
        n++;
      }
      res.push({ platform: p.platform, requested: ups.length, recorded: n });
    } catch (e) { const m = (e as Error).message; warn('analytics collect failed', { platform: p.platform, err: m.slice(0, 120) }); res.push({ platform: p.platform, requested: ups.length, recorded: 0, error: m.slice(0, 200) }); }
  }
  return res;
}

/** Cross-platform summary for the UI/API: totals, latest per-clip views, and the best measured hour per platform. */
export function analyticsSummary(store: Store, tz: string, hourFn: (platform?: string) => { hour: number; views: number; samples: number }[]) {
  const platforms = store.all<{ platform: string }>(`SELECT DISTINCT platform FROM analytics_snapshots UNION SELECT DISTINCT platform FROM analytics`).map((r) => r.platform);
  return platforms.map((platform) => {
    const latest = store.all<{ remote_id: string; views: number | null; likes: number | null; published_at: string | null }>(`SELECT s.remote_id, s.views, s.likes, s.published_at FROM analytics_snapshots s JOIN (SELECT remote_id, max(id) mid FROM analytics_snapshots WHERE platform=? GROUP BY remote_id) m ON m.mid=s.id ORDER BY s.views DESC`, platform);
    const hs = hourFn(platform).filter((h) => h.samples > 0).sort((a, b) => b.views / b.samples - a.views / a.samples)[0];
    return { platform, videos: latest.length, totalViews: latest.reduce((a, x) => a + (x.views ?? 0), 0), top: latest.slice(0, 5), bestHour: hs ? { hour: hs.hour, meanViews: Math.round(hs.views / hs.samples), samples: hs.samples } : null, tz };
  });
}
