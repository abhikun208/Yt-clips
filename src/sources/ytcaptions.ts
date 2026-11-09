import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Cue, Word } from '../analysis/transcript.ts';
import { run } from '../util/proc.ts';
import { warn } from '../util/log.ts';

/**
 * Key-free, instant speech-to-text for YouTube sources: YouTube's own caption track (auto-generated or uploaded) via yt-dlp, json3 format.
 * json3 carries a start time for every spoken word, so captions get real word timing without running any model on the phone.
 * Quality is YouTube's, not ours: it is used only when the language matches (`hi-orig`, `hi`, `en-orig`, `en` in that order; never a machine translation),
 * and the transcript is marked in `<base>.json.src` so `diag-clip` shows where the words came from. The owner can switch it off (stt.youtubeCaptions=false).
 */
interface J3 { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] }

/** json3 -> cues with per-word times. Pure; malformed events are skipped, nothing is invented. */
export function parseJson3(txt: string): Cue[] {
  let j: J3; try { j = JSON.parse(txt) as J3; } catch { return []; }
  const cues: Cue[] = []; let lastStart = -1;
  for (const ev of j.events ?? []) {
    if (!Array.isArray(ev.segs) || !Number.isFinite(ev.tStartMs)) continue;
    const t0 = ev.tStartMs! / 1000; const evEnd = t0 + (Number(ev.dDurationMs) > 0 ? Number(ev.dDurationMs) / 1000 : 2);
    const raw: { text: string; start: number }[] = [];
    for (const sg of ev.segs) { const t = String(sg.utf8 ?? '').replace(/\s+/g, ' ').trim(); if (!t || /^\[.*\]$/.test(t) || /^[♪♫\s]+$/.test(t)) continue; raw.push({ text: t, start: t0 + (Number(sg.tOffsetMs) || 0) / 1000 }); }
    if (!raw.length) continue;
    const words: Word[] = [];
    raw.forEach((w, i) => { const end = Math.min(evEnd, i + 1 < raw.length ? raw[i + 1]!.start : evEnd); if (w.start > lastStart - 0.05) words.push({ text: w.text, start: w.start, end: end > w.start ? end : w.start + 0.25 }); });
    if (!words.length) continue;
    lastStart = words[words.length - 1]!.start;
    cues.push({ start: words[0]!.start, end: words[words.length - 1]!.end, text: words.map((w) => w.text).join(' '), words });
  }
  return cues;
}

const PRIORITY = ['hi-orig', 'hi', 'en-orig', 'en'];
/** Download the caption track next to the video (`<base>.json` = our sidecar format). Returns the language used, or null (no track / yt-dlp problem: never fatal). */
export async function fetchCaptions(url: string, base: string, extra: string[] = []): Promise<string | null> {
  const dir = dirname(base), stem = basename(base);
  try {
    await run('yt-dlp', [...extra, '--skip-download', '--no-playlist', '--no-warnings', '--write-auto-subs', '--write-subs', '--sub-langs', PRIORITY.join(','), '--sub-format', 'json3', '-o', `${base}.%(ext)s`, url], { timeoutMs: 3 * 60_000 });
    const files = readdirSync(dir).filter((f) => f.startsWith(stem + '.') && f.endsWith('.json3'));
    for (const lang of PRIORITY) {
      const f = files.find((x) => x === `${stem}.${lang}.json3`); if (!f) continue;
      const cues = parseJson3(readFileSync(`${dir}/${f}`, 'utf8'));
      if (cues.length >= 3) { writeFileSync(`${base}.json`, JSON.stringify(cues)); writeFileSync(`${base}.json.src`, `youtube-captions ${lang}`); return lang; }
    }
    return null;
  } catch (e) { warn('youtube captions not available (continuing with speech-to-text)', { why: (e as Error).message.slice(0, 120) }); return null; }
  finally { try { for (const f of readdirSync(dir)) if (f.startsWith(stem + '.') && f.endsWith('.json3')) rmSync(`${dir}/${f}`, { force: true }); } catch { /* ignore */ } }
}
export const captionSource = (base: string): string | null => (existsSync(base + '.json.src') ? readFileSync(base + '.json.src', 'utf8').trim() : null);
