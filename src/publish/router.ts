import type { Store } from '../db.ts';
import { info } from '../util/log.ts';

/**
 * Fair-share (round-robin) selection of which clips get queued next.
 * Problem it solves: one source with 15-20 clips used to be queued first-to-last, so a single account got a flood while other sources waited.
 * Rule: every tick takes AT MOST ONE clip per source (the oldest not yet attempted); a new round starts only after every source that has
 * eligible clips was served once. Sources with nothing eligible are skipped (they are served the moment they have a clip).
 * Pure core (`pickRound`) + a small DB wrapper (`fairPick`) so the rule is unit-testable without a database.
 */
export interface Cand { clipId: number; sourceId: number; lastAttemptAt: string | null }
export interface RoundResult { picks: Cand[]; served: number[]; newRound: boolean }

export function pickRound(cands: Cand[], served: Iterable<number>, o: { retryHours?: number; now?: number } = {}): RoundResult {
  const now = o.now ?? Date.now(); const cool = (o.retryHours ?? 6) * 3600_000;
  const eligible = cands.filter((c) => !c.lastAttemptAt || now - Date.parse(c.lastAttemptAt.includes('T') ? c.lastAttemptAt : c.lastAttemptAt.replace(' ', 'T') + 'Z') >= cool);
  const oldest = new Map<number, Cand>(); for (const c of [...eligible].sort((a, b) => a.clipId - b.clipId)) if (!oldest.has(c.sourceId)) oldest.set(c.sourceId, c);
  let done = new Set(served); let newRound = false;
  let todo = [...oldest.keys()].filter((s) => !done.has(s)).sort((a, b) => a - b);
  if (!todo.length && oldest.size) { done = new Set(); newRound = true; todo = [...oldest.keys()].sort((a, b) => a - b); } // every source served: next round
  const picks = todo.map((s) => oldest.get(s)!); for (const p of picks) done.add(p.sourceId);
  return { picks, served: [...done], newRound };
}

const key = (channelId: number, platform: string) => `router:served:${channelId}:${platform}`;

/**
 * Picks clips for one channel+platform from `rows` (already filtered: QC passed, metadata ok, not yet queued) and remembers the round in kv.
 * `maxQueuedPerSource`: a source that already has that many unfinished uploads is skipped while other sources are waiting (a lone source is never throttled).
 * Stamps `clips.last_attempt_at` on every pick and logs why nothing was picked (no silent failures).
 */
export function fairPick(store: Store, channelId: number, platform: string, rows: Cand[], o: { retryHours?: number; maxQueuedPerSource?: number; limit?: number; now?: number } = {}): number[] {
  if (!rows.length) return [];
  const raw = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', key(channelId, platform))?.v; let served: number[] = []; try { served = raw ? (JSON.parse(raw) as number[]) : []; } catch { served = []; }
  const sources = new Set(rows.map((r) => r.sourceId)); const cap = o.maxQueuedPerSource ?? 2;
  const busy = new Set<number>();
  if (sources.size > 1) for (const s of sources) { const n = store.get<{ n: number }>(`SELECT COUNT(*) n FROM uploads u JOIN clips c ON c.id=u.clip_id JOIN candidates k ON k.id=c.candidate_id JOIN videos v ON v.id=k.video_id WHERE COALESCE(v.source_id,0)=? AND u.platform=? AND u.state NOT IN ('PUBLISHED','QC_FAILED','FAILED')`, s, platform)?.n ?? 0; if (n >= cap) busy.add(s); }
  const usable = rows.filter((r) => !busy.has(r.sourceId));
  if (!usable.length) { info('fair-share: nothing picked - every source already has its max queued uploads', { channel: channelId, platform, cap, sources: sources.size }); return []; }
  const r = pickRound(usable, served, { retryHours: o.retryHours, now: o.now });
  if (!r.picks.length) { info('fair-share: nothing picked - all eligible clips were attempted recently', { channel: channelId, platform, retryHours: o.retryHours ?? 6 }); return []; }
  store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')`, key(channelId, platform), JSON.stringify(r.served));
  const picks = r.picks.slice(0, o.limit ?? r.picks.length); for (const p of picks) store.exec(`UPDATE clips SET last_attempt_at=datetime('now') WHERE id=?`, p.clipId);
  info('fair-share round', { channel: channelId, platform, picked: picks.map((p) => `${p.sourceId}:${p.clipId}`), newRound: r.newRound });
  return picks.map((p) => p.clipId);
}
