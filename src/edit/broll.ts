import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * B-roll = short cutaway footage (e.g. a train, rain, money) laid over the main video for 1-2 seconds while the speaker talks about it,
 * the way news/explainer Shorts keep the eye busy. Free stock source: Pexels (needs a free PEXELS_API_KEY; no key = no B-roll,
 * the clip's own close-up inserts are used instead). Pexels licence: free to use, no attribution required.
 */
export interface BrollClip { file: string; start: number; end: number }
export const brollKey = (): string => (process.env.PEXELS_API_KEY ?? '').trim();

/** Where the cutaways go: n slots of `len` seconds, never in the first/last 1.2 s; none for clips shorter than 9 s. */
export function planBroll(duration: number, len = 1.6): { start: number; end: number }[] {
  if (!(duration >= 9)) return [];
  const n = Math.min(3, Math.floor(duration / 5)); const out: { start: number; end: number }[] = [];
  for (let i = 0; i < n; i++) { const start = Math.round((1.2 + ((duration - 2.4 - len) * (i + 0.5)) / n) * 10) / 10; out.push({ start, end: Math.round((start + len) * 10) / 10 }); }
  return out;
}

/** Download up to `n` portrait stock videos for the AI's English search terms (cached by Pexels id). */
export async function fetchBroll(dir: string, terms: string[], n: number, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const key = brollKey(); if (!key || !n) return []; mkdirSync(dir, { recursive: true }); const files: string[] = [];
  for (const term of terms.map((t) => t.trim()).filter(Boolean)) {
    if (files.length >= n) break;
    try {
      const r = await fetchFn(`https://api.pexels.com/videos/search?query=${encodeURIComponent(term)}&per_page=5&orientation=portrait&size=medium`, { headers: { authorization: key }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const vids = ((await r.json()) as { videos?: { id: number; video_files?: { link: string; width: number; file_type: string }[] }[] }).videos ?? [];
      for (const v of vids) {
        const f = (v.video_files ?? []).filter((x) => x.file_type === 'video/mp4' && x.width >= 480 && x.width <= 1100).sort((a, b) => a.width - b.width)[0];
        if (!f) continue; const path = join(dir, `pexels_${v.id}.mp4`);
        if (files.includes(path)) continue;
        if (!existsSync(path) || statSync(path).size < 10_000) { const d = await fetchFn(f.link, { signal: AbortSignal.timeout(60_000) }); if (!d.ok) continue; writeFileSync(path, Buffer.from(await d.arrayBuffer())); }
        files.push(path); break;
      }
    } catch { /* one search term failing never blocks the clip */ }
  }
  return files;
}
