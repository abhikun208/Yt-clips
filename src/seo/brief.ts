import { keyphrases, splitSentences } from './local.ts';
import { hookScore } from '../analysis/textsignals.ts';
import type { Cue } from '../analysis/transcript.ts';

/**
 * "Analyse first, write second": everything the metadata may say comes from this brief, which is computed from the clip's own speech.
 * Nothing here is invented: highlights are real sentences, chapters are real moments (time + the words said there), keyphrases are
 * counted from the transcript.
 */
export interface Brief { summary: string; highlights: string[]; chapters: { t: number; label: string }[]; numbers: string[]; keyphrases: string[]; words: number; durationSec: number }

const short = (s: string, n: number) => { const c = s.replace(/[#@]\S+/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim().replace(/[.,;:!?\s]+$/, ''); const w = c.split(' '); const o = w.slice(0, n).join(' '); return o + (w.length > n ? '…' : ''); };
export const mmss = (t: number) => { const s = Math.max(0, Math.round(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** cues are on the SOURCE timeline; clipStart/duration select the part that is in the clip (times in the output are clip-relative). */
export function buildBrief(o: { transcript: string; cues?: Cue[]; clipStart?: number; duration?: number }): Brief {
  const text = (o.transcript ?? '').replace(/\s+/g, ' ').trim();
  const sents = splitSentences(text).filter((s) => s.split(' ').length >= 3);
  const kp = keyphrases(text, 8).map((k) => k.phrase);
  const highlights = [...sents.map((s, i) => ({ s, i, h: hookScore(s) }))].sort((a, b) => b.h - a.h).slice(0, 3).sort((a, b) => a.i - b.i).map((x) => short(x.s, 14)).filter((s) => s.length >= 8);
  const numbers = [...new Set(text.match(/\b\d+(?:[.,]\d+)?\s?(?:kills?|kill|k|%|percent|lakh|crore|million|rs|rupees?|₹|\$|days?|din|saal|years?|players?|squad|rank)?\b/gi) ?? [])].map((x) => x.trim()).filter((x) => /\d/.test(x)).slice(0, 4);
  const dur = o.duration ?? 0; const chapters: Brief['chapters'] = [];
  if (o.cues?.length && dur >= 30) {
    const s0 = o.clipStart ?? 0; const inC = o.cues.filter((c) => c.end > s0 && c.start < s0 + dur).sort((a, b) => a.start - b.start);
    const n = dur >= 50 ? 4 : 3; const step = dur / n; let last = -99;
    for (let k = 0; k < n; k++) {
      const a = s0 + k * step, b = a + step; const c = inC.find((x) => x.start >= a - 0.5 && x.start < b) ?? inC.find((x) => x.end > a && x.start < b); if (!c) continue;
      const t = k === 0 ? 0 : Math.max(0, c.start - s0); if (t - last < 10) continue; const lbl = short(c.text, 6); if (lbl.length < 3) continue; chapters.push({ t, label: lbl }); last = t;
    }
    if (chapters.length < 3) chapters.length = 0; // YouTube needs ≥3 chapters, first at 0:00, each ≥10 s
  }
  return { summary: sents.slice(0, 2).join(' ').slice(0, 220), highlights, chapters, numbers, keyphrases: kp, words: text.split(' ').filter(Boolean).length, durationSec: dur };
}

export interface DescParts { about: string; highlights: string[]; chapters: Brief['chapters']; searches: string[]; related: string[]; hashtags: string[]; sourceTitle?: string; channelName?: string; links?: { label: string; url: string }[]; lang: 'hi' | 'hinglish' | 'en' | 'unknown'; part?: { no: number; total: number } | null }
const H = {
  hi: { hl: '📌 इस वीडियो में', map: '⏱ टाइम मैप', find: '🔎 खोजें', rel: '🔥 जुड़े विषय', full: 'पूरा वीडियो', more: 'और भी: चैनल पर ऐसे और क्लिप देखें और फॉलो करें।' },
  hinglish: { hl: '📌 Is video mein', map: '⏱ Time map', find: '🔎 Search karo', rel: '🔥 Related topics', full: 'Poori video', more: 'Aur bhi: channel par aise aur clips dekho aur follow karo.' },
  en: { hl: '📌 In this clip', map: '⏱ Time map', find: '🔎 Search', rel: '🔥 Related topics', full: 'Full video', more: 'And more: follow the channel for more clips like this.' },
} as const;

/** Description layout: about → highlights → time map → search keywords → related topics → full video/links → "and more" → hashtags. First 2 lines carry the main keyword (that is what search + the "more" fold show). */
export function composeDescription(d: DescParts): string {
  const h = H[d.lang === 'unknown' ? 'en' : d.lang]; const L: string[] = [];
  if (d.part) L.push(d.part.no < d.part.total ? `Part ${d.part.no}/${d.part.total} — agla part dekhna mat bhoolna!` : `Part ${d.part.no}/${d.part.total} — series ka last part.`, '');
  L.push(d.about.trim() || (d.lang === 'en' ? 'The best moment of this video.' : 'Is video ka sabse khaas moment.'));
  if (d.highlights.length) { L.push('', h.hl); for (const x of d.highlights) L.push(`• ${x}`); }
  if (d.chapters.length >= 3) { L.push('', h.map); for (const c of d.chapters) L.push(`${mmss(c.t)} ${c.label}`); }
  if (d.searches.length) L.push('', `${h.find}: ${d.searches.slice(0, 5).join(' | ')}`);
  if (d.related.length) L.push('', `${h.rel}: ${d.related.slice(0, 6).join(', ')}`);
  if (d.sourceTitle) L.push('', `${h.full}: ${d.sourceTitle}${d.channelName ? ` (${d.channelName})` : ''}`);
  if (d.links?.length) { L.push(''); for (const l of d.links) L.push(`${l.label}: ${l.url}`); }
  L.push('', h.more);
  if (d.hashtags.length) L.push('', d.hashtags.slice(0, 5).join(' '));
  return L.join('\n').slice(0, 4900);
}

/** Platform captions have hard limits (Telegram 1024, Discord 2000, Meta ~2200): drop the optional sections first (time map, related, search line), then trim, but always keep the hashtags line. */
export function fitCaption(title: string, description: string, max: number): string {
  const make = (d: string) => `${title}\n\n${d}`;
  if (make(description).length <= max) return make(description);
  const blocks = description.split('\n\n'); const tags = /^#/.test(blocks[blocks.length - 1] ?? '') ? blocks.pop()! : '';
  const drop = [/^⏱/, /^🔥/, /^🔎/, /^📌/, /^(Poori video|Full video|पूरा वीडियो)/];
  let cur = blocks;
  for (const re of drop) { if (make([...cur, tags].filter(Boolean).join('\n\n')).length <= max) break; cur = cur.filter((b) => !re.test(b)); }
  let out = make([...cur, tags].filter(Boolean).join('\n\n'));
  if (out.length > max) { const keep = make(tags ? `\n\n${tags}` : '').length; out = out.slice(0, Math.max(0, max - Math.min(keep, 120) - 1)).trimEnd() + (tags ? `…\n\n${tags}` : '…'); }
  return out.slice(0, max);
}
