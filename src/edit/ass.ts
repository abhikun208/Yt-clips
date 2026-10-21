// Backwards-compatible wrapper: the original single-style captions now run through the preset engine (captions.ts).
import type { Cue } from '../analysis/transcript.ts';
import { buildStyledAss } from './captions.ts';

export interface AssOpts { width: number; height: number; font: string; highlight: string; wordsPerChunk: number }
export function buildAss(cues: Cue[], clipStart: number, clipEnd: number, title: string | null, o: AssOpts): string {
  return buildStyledAss(cues, clipStart, clipEnd, title, { width: o.width, height: o.height }).ass;
}
