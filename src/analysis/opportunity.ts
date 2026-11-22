/**
 * Content opportunity score (0-100) computed BEFORE editing from evidence the analyzer already has. 13 sub-scores, each with a basis:
 *  MEASURED    = derived from audio/scene/learning numbers,
 *  HEURISTIC   = derived from transcript wording (a rule of thumb, not a measurement),
 *  UNAVAILABLE = no evidence (e.g. real competition / search volume): left out of the average and listed, never invented.
 * Pure: no I/O. It does not change candidate ranking; it can only be used as an extra rejection threshold (cfg.clip.opportunityMin).
 */
import { scoreText } from './keywords.ts';
import { similarity } from './qualitygate.ts';

export const PARTS = ['hook', 'curiosity', 'emotion', 'action', 'storyContext', 'surprise', 'originality', 'audienceFit', 'replay', 'shareability', 'searchPotential', 'competition', 'payoff'] as const;
export type PartKey = (typeof PARTS)[number];
export type Basis = 'MEASURED' | 'HEURISTIC' | 'UNAVAILABLE';
export interface Part { value: number | null; basis: Basis; reason: string }
export interface Opportunity { score: number | null; parts: Record<PartKey, Part>; unavailable: PartKey[]; reasons: string[] }
export interface OppInput { signals: Record<string, number>; transcript: string; hook: string; category: string; duration: number }
export interface OppCtx { /** 0..1 max similarity to clips already made */ similarityToPast?: number; /** learned category multiplier (1 = neutral) */ categoryPrior?: number; /** 0..1 how crowded the topic is (needs real search data) */ competition?: number }
const WEIGHT: Record<PartKey, number> = { hook: 14, curiosity: 8, emotion: 8, action: 8, storyContext: 8, surprise: 6, originality: 8, audienceFit: 8, replay: 6, shareability: 6, searchPotential: 6, competition: 4, payoff: 10 };
const clamp = (n: number) => Math.max(0, Math.min(100, n)); const r0 = (n: number) => Math.round(n);
const CURIOUS = /\?|\b(why|how|what happens|secret|nobody|never seen|wait for it|kya|kaise|kyun|kyu|dekho|dekhna)\b/i;
const SURPRISE = /\b(wait|omg|no way|unbelievable|suddenly|shocking|insane|crazy|achanak|pagal|what the)\b/i;
const U = (reason: string): Part => ({ value: null, basis: 'UNAVAILABLE', reason });
const P = (value: number, basis: Basis, reason: string): Part => ({ value: r0(clamp(value)), basis, reason });

export function opportunity(c: OppInput, ctx: OppCtx = {}): Opportunity {
  const s = c.signals; const t = c.transcript ?? ''; const words = t.split(/\s+/).filter(Boolean).length; const ts = scoreText(t); const hasText = words >= 4;
  const hookLine = s.hookLine ?? 0; const hookV = Math.max(hookLine, ts.hook) * 100;
  const emotionV = ts.emotion ? 75 + Math.min(25, (s.peak ?? 0) * 25) : (s.peak ?? 0) * 40;
  const actionV = ((s.peak ?? 0) * 0.5 + (s.pace ?? 0) * 0.3 + Math.max(s.gaming ?? 0, s.external ?? 0) * 0.2) * 100;
  const surpriseV = (SURPRISE.test(t) ? 55 : 0) + (s.variance ?? 0) * 100 * 0.45;
  const storyV = (s.complete ?? 0) * 60 + (words >= 12 ? 40 : words * 3);
  const replayV = (c.duration <= 20 ? 60 : c.duration <= 35 ? 40 : 20) + (s.complete ?? 0) * 40;
  const parts: Record<PartKey, Part> = {
    hook: hasText || hookLine > 0 ? P(hookV, hasText ? 'HEURISTIC' : 'MEASURED', hookLine >= 0.5 ? 'strong opening line' : ts.hook > 0 ? 'hook words in speech' : 'no clear hook line') : U('no transcript to judge the opening'),
    curiosity: hasText ? P(CURIOUS.test(t) ? 70 + (hookLine >= 0.5 ? 20 : 0) : 20, 'HEURISTIC', CURIOUS.test(t) ? 'question/curiosity wording' : 'no curiosity wording') : U('no transcript'),
    emotion: P(emotionV, ts.emotion ? 'HEURISTIC' : 'MEASURED', ts.emotion ? `emotion words (${ts.emotion}) + audio` : 'audio energy only'),
    action: P(actionV, 'MEASURED', 'audio peak + scene changes + game/chat signals'),
    storyContext: hasText ? P(storyV, 'MEASURED', (s.complete ?? 0) >= 1 ? 'clean start and end on natural pauses' : 'cut points are not on pauses') : U('no transcript'),
    surprise: P(surpriseV, SURPRISE.test(t) ? 'HEURISTIC' : 'MEASURED', SURPRISE.test(t) ? 'surprise wording + dynamic audio' : 'audio dynamics only'),
    originality: ctx.similarityToPast === undefined ? U('no history to compare with') : P((1 - Math.max(0, Math.min(1, ctx.similarityToPast))) * 100, 'MEASURED', `max text similarity to earlier clips ${(ctx.similarityToPast * 100).toFixed(0)}%`),
    audienceFit: ctx.categoryPrior === undefined ? U('no learned audience data for this category yet') : P(50 + (ctx.categoryPrior - 1) * 250, 'MEASURED', `learned category multiplier x${ctx.categoryPrior.toFixed(2)}`),
    replay: P(replayV, 'HEURISTIC', c.duration <= 20 ? 'short and complete: easy to re-watch' : 'longer clip: lower replay chance'),
    shareability: P((emotionV + surpriseV + actionV) / 3, 'HEURISTIC', 'average of emotion, surprise and action'),
    searchPotential: hasText ? P(Math.min(100, new Set(t.toLowerCase().match(/[a-zऀ-ॿ]{5,}/g) ?? []).size * 6), 'HEURISTIC', 'keyword richness only; real search volume is UNAVAILABLE') : U('no transcript'),
    competition: ctx.competition === undefined ? U('needs real YouTube search data (quota-limited); not estimated') : P((1 - ctx.competition) * 100, 'MEASURED', `topic crowding ${(ctx.competition * 100).toFixed(0)}%`),
    payoff: hasText || (s.payoff ?? 0) > 0 ? P((s.payoff ?? 0) * 100, hasText ? 'HEURISTIC' : 'MEASURED', (s.payoff ?? 0) >= 0.9 ? 'ends on a finished thought' : 'ending is not clearly finished') : U('no transcript'),
  };
  let num = 0, den = 0; const unavailable: PartKey[] = [];
  for (const k of PARTS) { const v = parts[k].value; if (v === null) unavailable.push(k); else { num += WEIGHT[k] * v; den += WEIGHT[k]; } }
  const score = den >= 40 ? r0(num / den) : null; // fewer than ~40% of the weight measurable -> no score at all
  const top = PARTS.filter((k) => (parts[k].value ?? 0) >= 70).map((k) => `${k}: ${parts[k].reason}`); const weak = PARTS.filter((k) => parts[k].value !== null && (parts[k].value ?? 0) < 30).map((k) => `weak ${k}: ${parts[k].reason}`);
  return { score, parts, unavailable, reasons: [...top, ...weak] };
}
/** Reject below the configured threshold. A candidate with NO score (not enough evidence) is kept: absence of evidence is not a rejection. */
export function rejectLowOpportunity<T extends OppInput>(cands: T[], min: number, ctxOf: (c: T) => OppCtx = () => ({})): { keep: T[]; dropped: { c: T; score: number }[] } {
  const keep: T[] = []; const dropped: { c: T; score: number }[] = [];
  for (const c of cands) { const o = opportunity(c, ctxOf(c)); if (o.score !== null && o.score < min) dropped.push({ c, score: o.score }); else keep.push(c); }
  return { keep, dropped };
}
export const maxSimilarity = (text: string, past: string[]): number => past.reduce((m, p) => Math.max(m, similarity(text, p)), 0);
