import type { Interval } from './signals.ts';
import type { Cue } from './transcript.ts';
import { textInRange, guessLanguage } from './transcript.ts';
import { scoreText } from './keywords.ts';
import { shortHash } from '../util/hash.ts';
import { sentencesFromCues, snapToSentences, hookScore, payoffScore, sentencesIn } from './textsignals.ts';

export interface SelectParams { minSec: number; maxSec: number; targetSec: number; maxClips: number; minScore: number; maxOverlap: number }
export interface Candidate {
  start: number; end: number; duration: number; score: number; category: string; reason: string; hook: string;
  transcript: string; language: string; confidence: number; signals: Record<string, number>; fingerprint?: string;
}
export interface SelectInput {
  videoKey: string; duration: number; introEnd: number; outroStart: number;
  energy: number[]; energyStep: number; scenes: number[]; silence: Interval[]; cues: Cue[];
  /** optional: live-chat / replay-heatmap series and the gaming profile (see external.ts) */
  external?: Series[]; gaming?: boolean;
  /** category -> multiplier learned from this channel's own retention data (0.9..1.15) */
  categoryPrior?: Record<string, number>;
}

import { externalBoost, gamingScore, type Series } from './external.ts';
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function sliceEnergy(e: number[], step: number, a: number, b: number): number[] {
  return e.slice(Math.max(0, Math.floor(a / step)), Math.max(0, Math.ceil(b / step)));
}
function silenceRatio(sil: Interval[], a: number, b: number): number {
  let s = 0; for (const i of sil) s += Math.max(0, Math.min(b, i.end) - Math.max(a, i.start));
  return s / Math.max(0.001, b - a);
}
export function overlapRatio(a: [number, number], b: [number, number]): number {
  const o = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  return o / Math.max(0.001, Math.min(a[1] - a[0], b[1] - b[0]));
}

/** Snap a boundary to the nearest natural pause (silence) within tol so clips don't cut mid-word. */
function snap(t: number, sil: Interval[], tol: number, lo: number, hi: number): number {
  let best = t; let bd = tol;
  for (const i of sil) {
    const mid = (i.start + i.end) / 2;
    const d = Math.abs(mid - t);
    if (d < bd && mid >= lo && mid <= hi) { bd = d; best = Math.min(hi, Math.max(lo, mid)); }
  }
  return best;
}

/**
 * Slide windows over the USABLE span [introEnd, outroStart] — the whole timeline, not just the start.
 * Score = weighted energy peak/variance, scene dynamism, speech density, text hook/emotion, penalised by silence and filler.
 * Then NMS picks distinct, non-overlapping top windows. Quality floor (minScore) prevents filler clips.
 */
export function selectCandidates(inp: SelectInput, p: SelectParams): Candidate[] {
  const lo = inp.introEnd; const hi = inp.outroStart;
  if (hi - lo < p.minSec) return [];
  const hasText = inp.cues.length > 0; const sents = hasText ? sentencesFromCues(inp.cues) : [];
  const stride = Math.max(2, p.targetSec / 6);
  const lens = [...new Set([p.minSec, (p.minSec + p.targetSec) / 2, p.targetSec, (p.targetSec + p.maxSec) / 2, p.maxSec].map((x) => Math.round(x)))].filter((x) => x >= p.minSec && x <= p.maxSec);
  const all: Candidate[] = [];

  for (let s = lo; s + p.minSec <= hi + 1e-6; s += stride) {
    for (const len of lens) {
      let a = s; let b = Math.min(hi, s + len);
      if (b - a < p.minSec) continue;
      a = snap(a, inp.silence, 1.2, lo, b - p.minSec);
      b = snap(b, inp.silence, 1.2, a + p.minSec, hi);
      if (hasText) [a, b] = snapToSentences(a, b, sents, { lo, hi, minLen: p.minSec, maxLen: p.maxSec });
      const dur = b - a;
      if (dur < p.minSec || dur > p.maxSec + 0.01) continue;
      const en = sliceEnergy(inp.energy, inp.energyStep, a, b);
      const energyMean = mean(en);
      const peak = en.length ? Math.max(...en) : 0;
      const variance = en.length ? Math.sqrt(mean(en.map((x) => (x - energyMean) ** 2))) : 0;
      const cuts = inp.scenes.filter((t) => t >= a && t <= b).length;
      const pace = clamp01(cuts / Math.max(1, dur / 6));
      const sil = silenceRatio(inp.silence, a, b);
      const txt = hasText ? textInRange(inp.cues, a, b) : '';
      const words = txt ? txt.split(/\s+/).length : 0;
      const speech = hasText ? clamp01(words / (dur * 2.2)) : clamp01(1 - sil);
      const ts = scoreText(txt); const inS = hasText ? sentencesIn(sents, a, b) : []; const hk = inS.length ? hookScore(inS[0]!.text) : 0; const pay = inS.length ? payoffScore(inS[inS.length - 1]!.text) : 0;
      // Narrative completeness: starts right after a pause and ends on one (clean cut points).
      const cleanStart = inp.silence.some((i) => Math.abs((i.start + i.end) / 2 - a) < 1.3 || Math.abs(i.end - a) < 0.6) ? 1 : 0;
      const cleanEnd = inp.silence.some((i) => Math.abs((i.start + i.end) / 2 - b) < 1.3 || Math.abs(i.start - b) < 0.6) ? 1 : 0;
      const complete = (cleanStart + cleanEnd) / 2;
      const lenFit = 1 - Math.min(1, Math.abs(dur - p.targetSec) / p.targetSec) * 0.5;

      let score = 0.28 * clamp01(peak * 0.6 + energyMean * 0.4) + 0.12 * clamp01(variance * 2.5) + 0.12 * pace + 0.16 * speech
        + 0.16 * complete + 0.06 * lenFit + (hasText ? 0.1 * Math.max(ts.hook, ts.emotion ? 0.7 : 0) + 0.08 * hk + 0.04 * pay : 0.0);
      const ext = inp.external?.length ? externalBoost(inp.external, a, b) : 0; const gm = inp.gaming && hasText ? gamingScore(txt) : 0;
      score += 0.22 * ext + 0.12 * gm; // audience reaction (chat/replays) is the strongest free signal; gaming callouts add on top
      score *= 1 - 0.8 * clamp01(sil - 0.25) - 0.6 * ts.filler;
      score = clamp01(score);

      const category = gm >= 0.66 ? 'gaming_moment' : ext >= 0.7 ? 'crowd_reaction' : ts.emotion ?? (peak > 0.85 && variance > 0.2 ? 'high_energy' : pace > 0.6 ? 'dynamic_visuals' : speech > 0.6 ? 'dialogue' : 'general');
      const prior = inp.categoryPrior?.[category]; if (prior) score = clamp01(score * prior);
      const reasons = [
        peak > 0.8 ? 'audio energy peak' : '', variance > 0.2 ? 'dynamic audio' : '', pace > 0.5 ? 'frequent scene changes' : '',
        complete >= 1 ? 'clean start/end on natural pauses' : '', ts.hook > 0 ? 'hook words in speech' : '', hk >= 0.5 ? 'strong opening line' : '', pay >= 0.9 ? 'ends on a finished thought' : '', ext >= 0.5 ? 'chat/replay spike' : '', gm > 0 ? 'gaming callouts in speech' : '', ts.emotion ? `emotion cue: ${ts.emotion}` : '',
      ].filter(Boolean);
      all.push({
        start: +a.toFixed(2), end: +b.toFixed(2), duration: +dur.toFixed(2), score: +score.toFixed(4), category,
        reason: reasons.join('; ') || 'steady content', hook: (inS[0]?.text ?? txt.split(/(?<=[.!?।])\s+/)[0] ?? '').slice(0, 140),
        transcript: txt, language: guessLanguage(txt), confidence: +(hasText ? 0.7 : 0.5).toFixed(2),
        signals: { peak: +peak.toFixed(3), energy: +energyMean.toFixed(3), variance: +variance.toFixed(3), pace: +pace.toFixed(3), silence: +sil.toFixed(3), external: +ext.toFixed(3), gaming: +gm.toFixed(3), speech: +speech.toFixed(3), complete, hookLine: +hk.toFixed(2), payoff: +pay.toFixed(2) },
      });
    }
  }

  all.sort((x, y) => y.score - x.score);
  const picked: Candidate[] = [];
  for (const c of all) {
    if (c.score < p.minScore) break;
    if (picked.length >= p.maxClips) break;
    if (picked.every((q) => overlapRatio([c.start, c.end], [q.start, q.end]) <= p.maxOverlap)) {
      c.fingerprint = shortHash(`${inp.videoKey}:${Math.round(c.start)}:${Math.round(c.end)}`, 16);
      picked.push(c);
    }
  }
  return picked.sort((x, y) => x.start - y.start);
}
