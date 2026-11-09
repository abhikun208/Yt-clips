import type { Cue } from '../analysis/transcript.ts';

/**
 * Speech-to-text engines sometimes "hear" words in digital silence (a classic hallucination: one stray word over the quiet first second).
 * `silent` = ranges (seconds, relative to the clip) where the clip's own audio is below the noise floor; `offset` = clip start in source time (cues are absolute).
 * A word whose middle falls inside a silent range is dropped; a cue left without words (or a word-less cue lying entirely inside silence) is dropped. Never invents anything.
 */
export function gateSilence(cues: Cue[], silent: [number, number][], offset: number): { cues: Cue[]; dropped: number } {
  if (!silent.length) return { cues, dropped: 0 };
  const inSil = (a: number, b: number): boolean => { const m = (a + b) / 2 - offset; return silent.some(([s, e]) => m >= s && m <= e); };
  const wholly = (a: number, b: number): boolean => silent.some(([s, e]) => a - offset >= s - 0.05 && b - offset <= e + 0.05);
  let dropped = 0; const out: Cue[] = [];
  for (const q of cues) {
    if (q.words?.length) {
      const keep = q.words.filter((w) => !inSil(w.start, w.end)); dropped += q.words.length - keep.length;
      if (!keep.length) continue;
      out.push(keep.length === q.words.length ? q : { ...q, words: keep, text: keep.map((w) => w.text).join(' '), start: keep[0]!.start, end: Math.max(keep[keep.length - 1]!.end, keep[0]!.start + 0.1) });
    } else if (wholly(q.start, q.end)) { dropped++; } else out.push(q);
  }
  return { cues: out, dropped };
}
