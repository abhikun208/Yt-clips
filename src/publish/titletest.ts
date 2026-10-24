import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { assertPublishAllowed } from '../config.ts';
import { YouTubeAdapter } from './youtube.ts';
import { getChannel, mainChannel, ytSecretName } from '../channels.ts';
import { connectedScope, YT_FORCE_SSL_SCOPE } from './oauth.ts';
import { notify } from '../notify.ts';
import { warn } from '../util/log.ts';

/**
 * Title A/B by rotation. YouTube's API exposes NO impressions click-through rate (verified), so a true CTR test is impossible here.
 * Substitute: show each title variant for one window (default 24h), measure views per hour in that window, keep the best.
 * Honest limits: views decay with age, which favours the FIRST variants, so a later variant must beat the first by 20%+ to win;
 * with small view counts the result is noise. Treat as a weak hint. Needs automation.titleTest=true AND the public gate (it edits a
 * public video's title: 51 quota units per switch).
 */
export interface TitleTest { upload_id: number; remote_id: string; variants: string[]; idx: number; window_start: string; views_start: number | null; results: { title: string; views: number; hours: number; vph: number }[]; state: string; winner: string | null }
const row = (store: Store, id: number): TitleTest | null => { const r = store.get<{ upload_id: number; remote_id: string; variants_json: string; idx: number; window_start: string; views_start: number | null; results_json: string; state: string; winner: string | null }>('SELECT * FROM title_tests WHERE upload_id=?', id); return r ? { upload_id: r.upload_id, remote_id: r.remote_id, variants: JSON.parse(r.variants_json), idx: r.idx, window_start: r.window_start, views_start: r.views_start, results: JSON.parse(r.results_json), state: r.state, winner: r.winner } : null; };
export const listTitleTests = (store: Store) => store.all<{ upload_id: number }>('SELECT upload_id FROM title_tests ORDER BY upload_id DESC LIMIT 100').map((r) => row(store, r.upload_id)!);

/** Pick the winner: best views/hour, but the first variant is kept unless another beats it by >= 20% (decay bias). */
export function pickWinner(results: TitleTest['results']): { title: string; switched: boolean } {
  const first = results[0]!; const best = [...results].sort((a, b) => b.vph - a.vph)[0]!;
  return best !== first && best.vph >= first.vph * 1.2 ? { title: best.title, switched: true } : { title: first.title, switched: best !== first };
}

export async function titleTestTick(store: Store, cfg: Config, now = new Date()): Promise<{ started: number; switched: number; finished: number; errors: string[] }> {
  const r = { started: 0, switched: 0, finished: 0, errors: [] as string[] };
  if (!cfg.automation.titleTest) return r;
  try { assertPublishAllowed(cfg, 'public'); } catch { return r; } // editing a public title is a public action: same gate
  const adFor = (channelId: number | null) => { const ch = channelId ? getChannel(store, channelId) : mainChannel(store); return new YouTubeAdapter(store, tokenFor(cfg, ch)); };
  // start tests on PUBLIC videos that have >= 2 distinct title variants
  const cand = store.all<{ id: number; remote_id: string; channel_id: number | null; metadata_json: string | null }>(`SELECT u.id, u.remote_id, u.channel_id, c.metadata_json FROM uploads u JOIN clips c ON c.id=u.clip_id WHERE u.platform='youtube_shorts' AND u.state='PUBLISHED' AND u.remote_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_tests t WHERE t.upload_id=u.id) LIMIT 10`);
  for (const u of cand) {
    try {
      const md = u.metadata_json ? JSON.parse(u.metadata_json) as { title?: string; titles?: string[] } : {}; const variants = [...new Set([md.title, ...(md.titles ?? [])].filter((t): t is string => !!t && t.length <= 100))].slice(0, 3); if (variants.length < 2) continue;
      const ad = adFor(u.channel_id); const st = await ad.titleState(u.remote_id); if (!st || st.privacy !== 'public' || st.views === null) continue;
      if (st.title !== variants[0]) variants.unshift(st.title), variants.splice(3); // whatever is live now is variant 0
      store.exec('INSERT INTO title_tests(upload_id, remote_id, variants_json, idx, window_start, views_start) VALUES (?,?,?,?,?,?)', u.id, u.remote_id, JSON.stringify(variants), 0, now.toISOString(), st.views); r.started++;
    } catch (e) { r.errors.push(`start ${u.id}: ${(e as Error).message.slice(0, 80)}`); if (/^(AUTH_|QUOTA_)/.test((e as Error).message)) break; }
  }
  for (const t of store.all<{ upload_id: number }>(`SELECT upload_id FROM title_tests WHERE state='running'`).map((x) => row(store, x.upload_id)!)) {
    const hours = (now.getTime() - Date.parse(t.window_start)) / 3600_000; if (hours < cfg.automation.titleTestHours) continue;
    try {
      const up = store.get<{ channel_id: number | null }>('SELECT channel_id FROM uploads WHERE id=?', t.upload_id); const ad = adFor(up?.channel_id ?? null); const st = await ad.titleState(t.remote_id);
      if (!st || st.views === null || t.views_start === null) { r.errors.push(`test ${t.upload_id}: no stats`); continue; }
      const views = Math.max(0, st.views - t.views_start); t.results.push({ title: t.variants[t.idx]!, views, hours: +hours.toFixed(2), vph: +(views / hours).toFixed(3) });
      if (t.idx + 1 < t.variants.length) {
        await ad.setTitle(t.remote_id, t.variants[t.idx + 1]!); r.switched++;
        store.exec(`UPDATE title_tests SET idx=?, window_start=?, views_start=?, results_json=?, updated_at=datetime('now') WHERE upload_id=?`, t.idx + 1, now.toISOString(), st.views, JSON.stringify(t.results), t.upload_id);
      } else {
        const w = pickWinner(t.results); if (st.title !== w.title) await ad.setTitle(t.remote_id, w.title);
        store.exec(`UPDATE title_tests SET state='done', winner=?, results_json=?, updated_at=datetime('now') WHERE upload_id=?`, w.title, JSON.stringify(t.results), t.upload_id); r.finished++;
        void notify(store, cfg, `tt:${t.upload_id}`, `Title test finished (upload #${t.upload_id}): "${w.title}" kept. Weak evidence, views/hour only.`);
      }
    } catch (e) { r.errors.push(`test ${t.upload_id}: ${(e as Error).message.slice(0, 80)}`); warn('title test step failed', { id: t.upload_id }); if (/^(AUTH_|QUOTA_)/.test((e as Error).message)) break; }
  }
  return r;
}

/** One top-level "full live here" comment per published video of a channel that has liveUrl. Needs automation.funnelComment + gates.commentsAutoPost + force-ssl scope. Pinning must be done by the owner in Studio. */
export async function funnelTick(store: Store, cfg: Config): Promise<{ posted: number; errors: string[] }> {
  const r = { posted: 0, errors: [] as string[] };
  if (!cfg.automation.funnelComment || !cfg.gates.commentsAutoPost) return r;
  const ups = store.all<{ id: number; remote_id: string; channel_id: number | null }>(`SELECT u.id, u.remote_id, u.channel_id FROM uploads u WHERE u.platform='youtube_shorts' AND u.state='PUBLISHED' AND u.remote_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kv WHERE k='funnel:'||u.id) LIMIT 5`);
  for (const u of ups) {
    try {
      const ch = u.channel_id ? getChannel(store, u.channel_id) : mainChannel(store); const url = ch.config.liveUrl; if (!url) continue;
      const sc = connectedScope(secretsFor(cfg), ytSecretName(ch)); if (!sc || !sc.split(/\s+/).includes(YT_FORCE_SSL_SCOPE)) throw new Error('AUTH_SCOPE: connect with youtube-connect-full');
      const ad = new YouTubeAdapter(store, tokenFor(cfg, ch)); await ad.insertTopComment(u.remote_id, `Poora live yahan dekho: ${url}`);
      store.exec(`INSERT INTO kv(k,v) VALUES(?, '1') ON CONFLICT(k) DO NOTHING`, `funnel:${u.id}`); r.posted++;
      void notify(store, cfg, `pin:${u.id}`, `Comment posted on upload #${u.id}. YouTube API cannot pin: open Studio and pin it.`);
    } catch (e) { r.errors.push(`${u.id}: ${(e as Error).message.slice(0, 80)}`); if (/^(AUTH_|QUOTA_)/.test((e as Error).message)) break; }
  }
  return r;
}
import { secretsFor, tokenFor } from './service.ts';
