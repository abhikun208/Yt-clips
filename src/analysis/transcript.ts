import { readFileSync, existsSync } from 'node:fs';

export interface Cue { start: number; end: number; text: string }

function ts(s: string): number {
  const m = s.trim().replace(',', '.').match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Parse SRT/VTT text into cues. Invalid cues are skipped, never fabricated. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, c] = lines[i]!.split('-->');
    const start = ts(a ?? ''); const end = ts((c ?? '').trim().split(/\s+/)[0] ?? '');
    const body = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues;
}

/** Load a sidecar transcript if present (.srt/.vtt/.json [{start,end,text}]). Returns [] when none (no fake transcript). */
export function loadTranscript(base: string): Cue[] {
  for (const ext of ['.srt', '.vtt']) if (existsSync(base + ext)) return parseSubtitles(readFileSync(base + ext, 'utf8'));
  if (existsSync(base + '.json')) {
    try {
      const j = JSON.parse(readFileSync(base + '.json', 'utf8')) as Array<{ start: number; end: number; text: string }>;
      return j.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text);
    } catch { return []; }
  }
  return [];
}

export function textInRange(cues: Cue[], start: number, end: number): string {
  return cues.filter((c) => c.end > start && c.start < end).map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
}

/** Crude script/language tag: devanagari -> hi, latin with common Hindi words -> hinglish, else en. */
export function guessLanguage(t: string): 'hi' | 'hinglish' | 'en' | 'unknown' {
  if (!t.trim()) return 'unknown';
  if (/[ऀ-ॿ]/.test(t)) return 'hi';
  const hits = (t.toLowerCase().match(/\b(hai|hain|kya|nahi|nahin|aur|mera|tum|aap|kaise|bhai|yaar|toh|ko|se|ka|ki|ke|raha|kar|karo|hoga)\b/g) ?? []).length;
  return hits >= 3 ? 'hinglish' : 'en';
}
