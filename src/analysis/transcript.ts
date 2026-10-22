import { readFileSync, existsSync } from 'node:fs';

export interface Word { start: number; end: number; text: string }
export interface Cue { start: number; end: number; text: string; /** real per-word timing when the STT engine provided it */ words?: Word[] }

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
  if (existsSync(base + '.edited.json')) { const e = loadJsonCues(base + '.edited.json'); if (e.length) return e; }
  for (const ext of ['.srt', '.vtt']) if (existsSync(base + ext)) return parseSubtitles(readFileSync(base + ext, 'utf8'));
  if (existsSync(base + '.json')) return loadJsonCues(base + '.json');
  return [];
}
function loadJsonCues(file: string): Cue[] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Cue[];
    return j.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text).map((c) => ({
      ...c, words: Array.isArray(c.words) ? c.words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.text) : undefined }));
  } catch { return []; }
}

export interface CueEdit { cue: number; text?: string; words?: { i: number; text: string }[] }
/**
 * Fix transcript wording WITHOUT moving timing. Word edits replace the word text (timing kept) and rebuild the cue text;
 * a cue-text edit on a cue with measured words keeps the word timings only if the word count is unchanged, otherwise drops them
 * (so captions fall back to honest approximate timing instead of misaligned "measured" timing).
 */
export function applyCueEdits(cues: Cue[], edits: CueEdit[]): Cue[] {
  const out = cues.map((c) => ({ ...c, words: c.words?.map((w) => ({ ...w })) }));
  for (const e of edits) {
    const c = out[e.cue]; if (!c) throw new Error(`invalid: no cue ${e.cue}`);
    if (e.words) {
      if (!c.words) throw new Error(`invalid: cue ${e.cue} has no word timing to edit`);
      for (const w of e.words) { const t = c.words[w.i]; if (!t) throw new Error(`invalid: no word ${w.i} in cue ${e.cue}`); const nt = w.text.trim(); if (!nt || nt.length > 60) throw new Error('invalid: word text must be 1..60 chars'); t.text = nt; }
      c.text = c.words.map((w) => w.text).join(' ');
    } else if (typeof e.text === 'string') {
      const nt = e.text.replace(/\s+/g, ' ').trim(); if (!nt || nt.length > 500) throw new Error('invalid: cue text must be 1..500 chars');
      const n = nt.split(' ').length; c.text = nt;
      if (c.words) { if (c.words.length === n) c.words.forEach((w, i) => { w.text = nt.split(' ')[i]!; }); else delete c.words; }
    }
  }
  return out;
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

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
function stamp(t: number, sep: string): string {
  const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)}${sep}${pad(ms % 1000, 3)}`;
}
/** Cues -> SRT/VTT, times relative to `offset` (clip start) and clipped to [offset, offset+len]. */
export function cuesToSubtitles(cues: Cue[], format: 'srt' | 'vtt', offset = 0, len = Infinity): string {
  const rows = cues.map((c) => ({ s: Math.max(c.start, offset) - offset, e: Math.min(c.end, offset + len) - offset, t: c.text })).filter((r) => r.e > r.s);
  const body = rows.map((r, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${stamp(r.s, format === 'srt' ? ',' : '.')} --> ${stamp(r.e, format === 'srt' ? ',' : '.')}\n${r.t}\n`).join('\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
}
