import type { Cue } from './transcript.ts';

export interface Sentence { start: number; end: number; text: string }
const TERM = /[.!?।]+["')\]]*$/;

/** Sentences with timing from cues. With word timing the cue is split at sentence-final punctuation; otherwise whole cues act as sentences. */
export function sentencesFromCues(cues: Cue[]): Sentence[] {
  const out: Sentence[] = [];
  for (const c of cues) {
    if (c.words?.length) {
      let cur: typeof c.words = [];
      for (const w of c.words) { cur.push(w); if (TERM.test(w.text)) { out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((x) => x.text).join(' ') }); cur = []; } }
      if (cur.length) out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((x) => x.text).join(' ') });
    } else out.push({ start: c.start, end: c.end, text: c.text });
  }
  return out;
}

/** Move a clip start to the nearest sentence start (within tol) and the end to the nearest sentence end, so clips don't open/close mid-thought. */
export function snapToSentences(a: number, b: number, sents: Sentence[], o: { lo: number; hi: number; tol?: number; minLen: number; maxLen?: number }): [number, number] {
  const tol = o.tol ?? 4; let A = a, B = b;
  let bd = tol; for (const s of sents) { const d = Math.abs(s.start - a); if (d < bd && s.start >= o.lo) { bd = d; A = Math.max(o.lo, s.start - 0.08); } }
  bd = tol; for (const s of sents) { const d = Math.abs(s.end - b); if (d < bd && s.end <= o.hi && (!o.maxLen || s.end + 0.15 - A <= o.maxLen)) { bd = d; B = Math.min(o.hi, s.end + 0.15); } }
  return B - A >= o.minLen ? [A, B] : [a, b];
}

const OPEN_Q = /^(kya|kaise|kyu|kyun|kab|kaun|kahan|kitna|kitne|how|why|what|when|who|which|can|do|does|did|is|are|क्या|कैसे|क्यों|कब|कौन|कहाँ|कितना)\b/i;
const CLAIM = /\b(never|always|worst|best|biggest|only|nobody|everyone|secret|truth|mistake|warning|stop|don'?t|dont|sabse|kabhi nahi|koi nahi|sach|raaz|galti|dhyan|ruko|सबसे|कभी नहीं|सच|राज|गलती|ध्यान)\b/i;
const CONTRAST = /\b(but|however|actually|lekin|par|magar|asal mein|दरअसल|लेकिन|मगर)\b/i;
const FILLER_START = /^(um+|uh+|so|toh|to|aur|and|hmm+|acha|achha|ok(ay)?|haan|तो|और|अच्छा)\b[\s,]/i;
const NUM = /\b\d[\d,.]*\s?(%|percent|lakh|crore|million|billion|k|x|saal|years?|din|days?|rupee|rs|₹|\$)?/i;

/** 0..1: how strong is this sentence as an opening hook (question/claim/number/contrast, tight length, no filler start). */
export function hookScore(text: string): number {
  const t = text.trim(); if (!t) return 0; const words = t.split(/\s+/).length; let s = 0;
  if (OPEN_Q.test(t) || /\?\s*$/.test(t)) s += 0.35; if (CLAIM.test(t)) s += 0.3; if (NUM.test(t)) s += 0.2; if (CONTRAST.test(t)) s += 0.1;
  s += words >= 4 && words <= 16 ? 0.15 : 0; if (FILLER_START.test(t)) s -= 0.25; if (words < 3) s -= 0.2;
  return Math.max(0, Math.min(1, s));
}
/** 0..1: does the clip end on a finished thought (terminal punctuation, enough words)? */
export function payoffScore(lastSentence: string): number { const t = lastSentence.trim(); const w = t.split(/\s+/).length; return (TERM.test(t) ? 0.6 : 0.2) + (w >= 4 ? 0.4 : 0); }
/** Sentences that overlap [a,b]. */
export const sentencesIn = (sents: Sentence[], a: number, b: number) => sents.filter((s) => s.end > a && s.start < b);
