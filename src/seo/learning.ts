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

/**
 * Semantic layer on top of the SQL winners: ONE short LLM call asks what the winning titles have in common (emotional hook / structure) and caches the answer until the
 * set of winners changes - so the title prompt gets an explanation ("they open with a question about a person"), not just examples. Uses the normal API provider chain.
 */
export async function hookInsight(store: Store, channelId: number, examples: string[], chain: { baseUrl: string; apiKey?: string; model: string }[], fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (examples.length < 2 || !chain.length) return null;
  const sig = examples.join('|'); const k = `hook-insight:${channelId}`; const cached = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v;
  if (cached) { try { const c = JSON.parse(cached) as { sig: string; text: string }; if (c.sig === sig) return c.text; } catch { /* recompute */ } }
  const { orderChain, llmFetch } = await import('../ai/health.ts');
  for (const env of orderChain(chain)) {
    try {
      const r = await llmFetch(fetchFn, env, `${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(25_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.2, max_tokens: 90, messages: [{ role: 'user', content: `These YouTube Shorts titles performed best on one channel:\n${examples.map((t) => `- ${t.slice(0, 90)}`).join('\n')}\nIn ONE sentence (max 30 words) say what emotional hook or structure they share. No advice, only the observation.` }] }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); const text = (((await r.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '').trim().replace(/\s+/g, ' ');
      if (text.length < 10 || text.length > 260 || /https?:\/\//.test(text)) continue;
      store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, JSON.stringify({ sig, text })); return text;
    } catch { /* next provider */ }
  }
  return null;
}
