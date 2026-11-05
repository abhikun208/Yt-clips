import type { Store } from '../db.ts';

/**
 * Learning loop: the channel's own measured winners become style examples for the next titles (no vector DB, no model training: a plain query over what analytics
 * already stored). Score = views / (age in days + 1) so old videos do not win just by being old. Only used when there is real evidence:
 * >= `min` published videos older than `minAgeDays`, and a title is a "winner" only if its score is >= 1.5x the channel median.
 */
export function topTitleExamples(store: Store, channelId: number, mainId: number, o: { min?: number; n?: number; minAgeDays?: number; now?: number } = {}): string[] {
  const now = o.now ?? Date.now(); const rows = store.all<{ views: number | null; published_at: string | null; metadata_json: string | null }>(
    `SELECT s.views, s.published_at, c.metadata_json FROM analytics_snapshots s JOIN (SELECT remote_id, max(id) mid FROM analytics_snapshots GROUP BY remote_id) m ON m.mid=s.id
     JOIN uploads u ON u.remote_id=s.remote_id AND u.platform IN ('youtube_shorts','youtube') JOIN clips c ON c.id=u.clip_id WHERE COALESCE(u.channel_id, ?)=? AND c.metadata_json IS NOT NULL`, mainId, channelId);
  const scored: { title: string; score: number }[] = [];
  for (const r of rows) {
    if (r.views == null || !r.published_at) continue; const age = (now - Date.parse(r.published_at.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.published_at) ? '' : 'Z'))) / 86_400_000; if (!(age >= (o.minAgeDays ?? 2))) continue;
    let title = ''; try { title = String((JSON.parse(r.metadata_json!) as { title?: string }).title ?? ''); } catch { continue; } title = title.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim(); if (title.length < 8) continue;
    scored.push({ title, score: r.views / (age + 1) });
  }
  if (scored.length < (o.min ?? 6)) return [];
  const sorted = scored.map((x) => x.score).sort((a, b) => a - b); const median = sorted[Math.floor(sorted.length / 2)]!;
  return scored.filter((x) => x.score > 0 && x.score >= 1.5 * median).sort((a, b) => b.score - a.score).slice(0, o.n ?? 3).map((x) => x.title);
}
