import { existsSync, readFileSync } from 'node:fs';

/**
 * External per-time signals for clip selection (all optional; absent => selection behaves exactly as before):
 *  - live chat replay: bursts of messages mark moments the audience reacted to (yt-dlp `--write-subs --sub-langs live_chat`
 *    writes `<video>.live_chat.json`, one JSON object per line with replayChatItemAction.videoOffsetTimeMsec).
 *  - "most replayed" heatmap from yt-dlp's info JSON (`heatmap: [{start_time,end_time,value}]`) saved as `<video>.heatmap.json`.
 * The parsers are tested on fixtures that follow those documented shapes; NO real yt-dlp run happened in this project's sandbox.
 */
export interface Series { name: string; step: number; values: number[] }
const num = (x: unknown) => { const n = typeof x === 'string' ? Number(x) : (x as number); return Number.isFinite(n) ? n : null; };

/** Message offsets (seconds) from a live_chat.json (NDJSON). Lines that are not chat items are skipped. */
export function parseLiveChat(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t || t[0] !== '{') continue;
    try { const j = JSON.parse(t) as { replayChatItemAction?: { videoOffsetTimeMsec?: string | number; actions?: unknown[] } }; const ms = num(j.replayChatItemAction?.videoOffsetTimeMsec); if (ms !== null && ms >= 0) out.push(ms / 1000); } catch { /* skip bad line */ }
  }
  return out;
}
/** Messages-per-bucket normalised to 0..1 by robust scaling (median -> 0, 95th percentile -> 1) so a busy chat is not "always high". */
export function chatSeries(offsets: number[], duration: number, step = 5): Series | null {
  if (offsets.length < 20 || duration <= 0) return null; // too little chat to mean anything
  const n = Math.ceil(duration / step); const c = new Array<number>(n).fill(0); for (const o of offsets) { const i = Math.floor(o / step); if (i >= 0 && i < n) c[i]!++; }
  const sorted = [...c].sort((a, b) => a - b); const med = sorted[Math.floor(n / 2)]!, p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))]!;
  const span = Math.max(1, p95 - med); return { name: 'chat', step, values: c.map((x) => Math.max(0, Math.min(1, (x - med) / span))) };
}
export function parseHeatmap(text: string): { start: number; end: number; value: number }[] {
  try { const j = JSON.parse(text) as unknown; const arr = Array.isArray(j) ? j : (j as { heatmap?: unknown[] }).heatmap; if (!Array.isArray(arr)) return [];
    return arr.map((h) => { const o = h as Record<string, unknown>; return { start: num(o.start_time) ?? NaN, end: num(o.end_time) ?? NaN, value: num(o.value) ?? NaN }; }).filter((h) => Number.isFinite(h.start) && Number.isFinite(h.end) && Number.isFinite(h.value) && h.end > h.start);
  } catch { return []; }
}
export function heatSeries(h: { start: number; end: number; value: number }[], duration: number, step = 5): Series | null {
  if (h.length < 4 || duration <= 0) return null; const n = Math.ceil(duration / step); const v = new Array<number>(n).fill(0);
  for (const s of h) for (let i = Math.floor(s.start / step); i <= Math.min(n - 1, Math.floor((s.end - 1e-6) / step)); i++) v[i] = Math.max(v[i]!, s.value);
  return { name: 'replayed', step, values: v };
}
/** Load whichever sidecars exist next to the video (`base` = path without extension). */
export function loadExternalSeries(base: string, duration: number): Series[] {
  const out: Series[] = [];
  for (const f of [`${base}.live_chat.json`, `${base}.chat.json`]) if (existsSync(f)) { try { const s = chatSeries(parseLiveChat(readFileSync(f, 'utf8')), duration); if (s) { out.push(s); break; } } catch { /* ignore */ } }
  if (existsSync(`${base}.heatmap.json`)) { try { const s = heatSeries(parseHeatmap(readFileSync(`${base}.heatmap.json`, 'utf8')), duration); if (s) out.push(s); } catch { /* ignore */ } }
  return out;
}
/** Strongest value of each series inside [a,b], averaged over series (0..1). */
export function externalBoost(series: Series[], a: number, b: number): number {
  if (!series.length) return 0; let sum = 0;
  for (const s of series) { const v = s.values.slice(Math.max(0, Math.floor(a / s.step)), Math.ceil(b / s.step)); sum += v.length ? Math.max(...v) * 0.7 + (v.reduce((x, y) => x + y, 0) / v.length) * 0.3 : 0; }
  return Math.min(1, sum / series.length);
}

/** Gaming vocabulary (Hinglish + English); matched as ONE text signal like the generic hook words. Free Fire / BGMI style callouts. */
export const GAMING_WORDS = ['booyah', 'booya', 'headshot', 'head shot', 'clutch', 'ace', 'squad wipe', 'wipe', 'knocked', 'knock', 'one tap', 'onetap', '1v1', '1v2', '1v3', '1v4', 'last zone', 'zone', 'rush', 'sniper', 'awm', 'grenade', 'revive', 'victory', 'champion', 'heroic', 'grandmaster', 'rank push', 'kill', 'down', 'finish', 'mar diya', 'maar diya', 'uda diya', 'gaya', 'khatam', 'bach gaya', 'chicken dinner', 'winner', 'chhoda nahi'];
export function gamingScore(t: string): number { const l = t.toLowerCase(); if (!l.trim()) return 0; const hits = GAMING_WORDS.filter((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/ /g, '\\s+')}([^a-z0-9]|$)`, 'i').test(l)).length; return Math.min(1, hits / 3); }
