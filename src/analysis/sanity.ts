import type { Cue } from './transcript.ts';

/**
 * Self-QA of a transcript (no human needed): finds Whisper's classic failures and scores the result.
 *  - hallucination loops ("thank you thank you thank you…", the same cue repeated) are removed;
 *  - junk cues (a "word" longer than 25 chars, mostly symbols, doubtful engine confidence avg_logprob < -1.2, high no_speech_prob) are counted;
 * `badRatio` > 0.3 means the engine's output should not be trusted blindly -> the caller tries the next engine (Gemini audio).
 */
export interface SanityReport { cues: Cue[]; removed: number; bad: number; badRatio: number }
const LOOP = /\b([\p{L}\p{N}']+)(?:[\s,.!?-]+\1\b){4,}/iu;
export function isJunkCue(c: Cue): boolean {
  const t = c.text.trim(); if (!t) return true;
  if (t.split(/\s+/).some((w) => w.length > 25)) return true;
  const letters = (t.match(/[\p{L}\p{N}]/gu) ?? []).length; if (letters / t.length < 0.5) return true;
  if (LOOP.test(t)) return true;
  if (c.conf && (c.conf.logprob < -1.2 || c.conf.no_speech > 0.85)) return true;
  return false;
}
export function checkTranscript(cues: Cue[]): SanityReport {
  const out: Cue[] = []; let removed = 0;
  for (const c of cues) { const prev = out[out.length - 1], prev2 = out[out.length - 2]; // the same text 3x in a row is a decoder loop, not speech
    const n = c.text.trim().toLowerCase(); if (prev && prev2 && prev.text.trim().toLowerCase() === n && prev2.text.trim().toLowerCase() === n) { removed++; continue; } out.push(c); }
  const bad = out.filter(isJunkCue).length;
  return { cues: out, removed, bad, badRatio: out.length ? bad / out.length : 0 };
}
