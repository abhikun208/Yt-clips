import type { Cue, Word } from './transcript.ts';
import type { Interval, Series as Plain } from './signals.ts';
import { sentencesFromCues, hookScore, payoffScore, type Sentence } from './textsignals.ts';
import { scoreText } from './keywords.ts';
import { gamingScore, externalBoost, type Series as Named } from './external.ts';
import { similarity } from './qualitygate.ts';

/**
 * Smart moment discovery: CHEAP SCAN -> DISCOVER EVENTS -> EXPAND CONTEXT -> EVALUATE -> SELECT.
 * Pure and streaming-friendly: it only reads the small per-second series the analyzer already computed (energy 0.5 s, scenes, motion 0.25 s,
 * silence intervals, transcript cues), so memory stays tiny and nothing is decoded here. Loudness is ONE event source among several and a
 * moment that rests on loudness alone can never rank above CONDITIONAL. Missing evidence (no transcript / motion / word timing) is listed,
 * excluded from the score (never scored as zero, never invented) and lowers the confidence.
 */
export type Tier = 'EXCEPTIONAL' | 'STRONG' | 'CONDITIONAL' | 'REJECTED';
export type EventKind = 'audio_surge' | 'audio_peak' | 'silence_break' | 'scene_burst' | 'motion_spike' | 'question' | 'exclamation' | 'reaction' | 'laughter' | 'external' | 'coverage';
export type Pattern = 'setup_punchline' | 'question_answer' | 'mistake_consequence' | 'attempt_result' | 'conflict_reaction' | 'suspense_reveal' | 'problem_solution' | 'challenge_outcome' | 'event_celebration' | 'story_payoff' | 'none';
export interface MomentEvent { t: number; kind: EventKind; strength: number }
export interface MomentInput {
  duration: number; lo: number; hi: number;
  energy: number[]; energyStep: number; silence: Interval[]; scenes: number[]; motion?: Plain; cues: Cue[]; external?: Named[]; gaming?: boolean;
}
export interface MomentCfg {
  minSec: number; maxSec: number; targetSec: number;
  weights: Record<'interest' | 'hook' | 'significance' | 'payoff' | 'context' | 'uniqueness' | 'reaction' | 'audio' | 'visual' | 'editing', number>;
  tiers: { exceptional: number; strong: number; conditional: number };
  maxEvents: number; clusterSec: number; coverageGapSec: number; preRollSec: number; postRollSec: number; setupLookbackSec: number; dupIoU: number; distinctMinGapSec: number;
}
export const DEFAULT_MOMENT_CFG: MomentCfg = {
  minSec: 15, maxSec: 60, targetSec: 35,
  weights: { interest: 0.16, hook: 0.1, significance: 0.16, payoff: 0.14, context: 0.1, uniqueness: 0.06, reaction: 0.08, audio: 0.06, visual: 0.08, editing: 0.06 },
  tiers: { exceptional: 0.72, strong: 0.56, conditional: 0.4 },
  maxEvents: 600, clusterSec: 8, coverageGapSec: 240, preRollSec: 6, postRollSec: 8, setupLookbackSec: 18, dupIoU: 0.6, distinctMinGapSec: 8,
};
export interface Moment {
  start: number; end: number; duration: number; tier: Tier; score: number; confidence: number; pattern: Pattern; kinds: EventKind[]; peakAt: number;
  breakdown: Record<string, number | null>; missing: string[]; reasons: string[]; explanation: string; hook: string; transcript: string;
  contextComplete: boolean | null; boundary: 'words' | 'sentences' | 'silence' | 'raw'; category: string; mergedFrom?: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
/** whole-word lexicon match that also works for Devanagari (\b does not) */
const lex = (terms: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const QUESTION = lex(['kya', 'kaise', 'kyu', 'kyun', 'kab', 'kaun', 'kahan', 'kitna', 'kitne', 'how', 'why', 'what', 'when', 'who', 'क्या', 'कैसे', 'क्यों', 'कब', 'कौन', 'कहाँ', 'कितना']);
const LAUGH = /(?:\b(?:ha){2,}h?\b|\bhehe+\b|\blol\b|\blmao\b|😂|🤣|\[laugh|\(laugh|हा हा|हाहा|हंस)/iu;
const REACT = lex(['arre', 'are yaar', 'arey', 'kya baat', 'zabardast', 'gazab', 'mast', 'pagal', 'ye kya', 'nahi nahi', 'oh no', 'omg', 'wow', 'oh my god', 'bach gaya', 'mar gaya', 'khatam', 'jeet gaye', 'booyah', 'अरे', 'क्या बात', 'ज़बरदस्त', 'जबरदस्त', 'गजब', 'गज़ब', 'मस्त', 'पागल', 'ये क्या', 'नहीं नहीं', 'बच गया', 'मार दिया', 'जीत गए']);
const P = {
  mistake: lex(['galti', 'oops', 'oh no', 'nahi nahi', 'mistake', 'miss ho gaya', 'chook', 'गलती', 'ओह नो', 'नहीं नहीं', 'चूक']), conseq: lex(['gaya', 'gir gaya', 'mar gaya', 'knocked', 'haar', 'fail', 'khatam', 'finished', 'गया', 'मर गया', 'हार', 'खत्म']),
  attempt: lex(['try', 'attempt', 'koshish', 'rush', 'push', 'jump', 'lagao', 'chalo', 'कोशिश', 'चलो']), result: lex(['kill', 'knocked', 'headshot', 'booyah', 'win', 'won', 'jeet', 'haar', 'ho gaya', 'hua', 'जीत', 'हार', 'हो गया', 'मार दिया']),
  challenge: lex(['challenge', 'bet', 'dare', 'shart', 'chunauti', 'चैलेंज', 'शर्त']), celeb: lex(['yeah', 'yes', 'booyah', 'wohoo', 'zabardast', 'mast', 'gazab', 'jeet gaye', 'champion', 'victory', 'ज़बरदस्त', 'जबरदस्त', 'गजब', 'मस्त', 'जीत गए', 'यस']),
  problem: lex(['problem', 'issue', 'dikkat', 'samasya', 'pareshani', 'दिक्कत', 'समस्या', 'परेशानी']), solution: lex(['solution', 'fix', 'solve', 'hal', 'tarika', 'ilaaj', 'समाधान', 'हल', 'तरीका', 'इलाज']),
  story: lex(['ek baar', 'once', 'story', 'kahani', 'एक बार', 'कहानी']), reveal: lex(['actually', 'asal mein', 'turns out', 'sach', 'secret', 'raaz', 'dekho', 'dekhiye', 'दरअसल', 'असल में', 'सच', 'राज']),
};
const CONT = /^\s*(and|but|because|which|aur|lekin|kyunki|toh phir)\b/i;
const sortNum = (a: number[]) => [...a].sort((x, y) => x - y);

/** 1. DISCOVER: events from every available source. Not limited to the loudest N; a periodic coverage check adds the quiet stretches. */
export function discoverEvents(inp: MomentInput, c: MomentCfg = DEFAULT_MOMENT_CFG): MomentEvent[] {
  const ev: MomentEvent[] = []; const e = inp.energy; const st = inp.energyStep; const sents = inp.cues.length ? sentencesFromCues(inp.cues) : [];
  if (e.length > 8 && st > 0) { // A. audio: local surges and peaks relative to the local baseline (a loud game is not "always interesting")
    const pre = [0]; for (const x of e) pre.push(pre[pre.length - 1]! + x);
    const avg = (a: number, b: number) => { a = Math.max(0, a); b = Math.min(e.length, b); return b > a ? (pre[b]! - pre[a]!) / (b - a) : 0; };
    const W = Math.max(4, Math.round(30 / st)); const N = Math.max(2, Math.round(2 / st)); const R = Math.max(2, Math.round(3 / st));
    for (let i = N; i < e.length; i++) { const over = e[i]! - avg(i - W, i - 1); if (e[i]! - avg(i - N, i) >= 0.2 && over >= 0.25) ev.push({ t: i * st, kind: 'audio_surge', strength: clamp01(over / 0.6) }); }
    for (let i = R; i < e.length - R; i++) { const x = e[i]!; if (x < 0.7) continue; let top = true; for (let j = i - R; j <= i + R; j++) if (e[j]! > x) { top = false; break; } const over = x - avg(i - W, i + W); if (top && over >= 0.2) ev.push({ t: i * st, kind: 'audio_peak', strength: clamp01(over / 0.6) }); }
  }
  for (const s of inp.silence) if (s.end - s.start >= 1.5) ev.push({ t: s.end, kind: 'silence_break', strength: clamp01((s.end - s.start) / 6) * 0.7 }); // B. quiet -> speech (suspense / reveal)
  { const sc = sortNum(inp.scenes); for (let i = 0; i < sc.length;) { let j = i; while (j + 1 < sc.length && sc[j + 1]! - sc[i]! <= 6) j++; const n = j - i + 1; if (n >= 3) { ev.push({ t: (sc[i]! + sc[j]!) / 2, kind: 'scene_burst', strength: clamp01(n / 7) }); i = j + 1; } else i++; } } // C. visual: bursts of cuts
  if (inp.motion && inp.motion.values.length > 8) { // D. visual: motion spikes, scaled by this video's own distribution
    const v = inp.motion.values; const s = sortNum(v); const p50 = s[Math.floor(s.length * 0.5)]!; const p95 = s[Math.floor(s.length * 0.95)]!; const span = Math.max(1, p95 - p50); const n = v.map((x) => clamp01((x - p50) / span));
    for (let i = 1; i < n.length; i++) if (n[i]! >= 0.75 && n[i - 1]! >= 0.5) { let j = i; while (j + 1 < n.length && n[j + 1]! >= 0.5) j++; ev.push({ t: i * inp.motion.step, kind: 'motion_spike', strength: clamp01(mean(n.slice(i, j + 1))) }); i = j + 1; }
  }
  for (const s of sents) { // E. transcript events (Hindi / Hinglish / English)
    const text = s.text; if (!text.trim()) continue; const words = text.trim().split(/\s+/).length; const sc = scoreText(text); const g = inp.gaming ? gamingScore(text) : 0;
    if (/\?\s*$/.test(text) || (words <= 12 && QUESTION.test(text) && /^\s*\S+/.test(text) && QUESTION.test(text.split(/\s+/).slice(0, 2).join(' ')))) ev.push({ t: s.start, kind: 'question', strength: 0.45 + 0.2 * hookScore(text) });
    if (/[!！]/.test(text) && words <= 10) ev.push({ t: s.start, kind: 'exclamation', strength: clamp01(0.45 + 0.1 * (text.match(/[!！]/g)?.length ?? 1)) });
    const rh = REACT.test(text) ? 1 : 0; if (rh || sc.emotion || g >= 0.34) ev.push({ t: s.start, kind: 'reaction', strength: clamp01(0.45 + 0.2 * rh + (sc.emotion ? 0.15 : 0) + 0.3 * g) });
    if (LAUGH.test(text) || sc.emotion === 'funny') ev.push({ t: s.start, kind: 'laughter', strength: 0.7 });
  }
  for (const x of inp.external ?? []) for (let i = 2; i < x.values.length - 2; i++) { const y = x.values[i]!; if (y >= 0.7 && y >= x.values[i - 1]! && y >= x.values[i + 1]!) ev.push({ t: i * x.step + x.step / 2, kind: 'external', strength: y }); }
  // F. coverage: any long stretch without events gets its most active 30 s sampled, so a quiet-but-good moment is not skipped
  { const ts = ev.map((x) => x.t).sort((a, b) => a - b); const edges = [inp.lo, ...ts.filter((t) => t >= inp.lo && t <= inp.hi), inp.hi];
    for (let k = 0; k + 1 < edges.length; k++) { const a = edges[k]!, b = edges[k + 1]!; if (b - a < c.coverageGapSec) continue;
      for (let g = a + 15; g + 30 <= b - 15; g += c.coverageGapSec) { let best = -1, bt = g; for (let w = g; w + 30 <= Math.min(b - 15, g + c.coverageGapSec); w += 15) { const words = sents.filter((s) => s.start >= w && s.start < w + 30).reduce((n, s) => n + s.text.split(/\s+/).length, 0); const sl = e.slice(Math.floor(w / (st || 1)), Math.ceil((w + 30) / (st || 1))); const act = words / 30 + (sl.length ? Math.sqrt(mean(sl.map((x) => (x - mean(sl)) ** 2))) : 0); if (act > best) { best = act; bt = w + 15; } } if (best > 0.05) ev.push({ t: bt, kind: 'coverage', strength: 0.3 }); } } }
  // de-noise: same kind within 1.5 s keeps the stronger; then bound memory
  ev.sort((x, y) => x.kind.localeCompare(y.kind) || x.t - y.t); const out: MomentEvent[] = [];
  for (const x of ev) { const l = out[out.length - 1]; if (l && l.kind === x.kind && x.t - l.t <= 1.5) { if (x.strength > l.strength) out[out.length - 1] = x; } else out.push(x); }
  return out.filter((x) => x.t >= inp.lo - 1 && x.t <= inp.hi + 1).sort((x, y) => y.strength - x.strength).slice(0, c.maxEvents).sort((x, y) => x.t - y.t);
}

interface Seed { peakAt: number; kinds: EventKind[]; strength: number; events: MomentEvent[] }
/** events close in time describe ONE moment; several independent sources agreeing makes it stronger */
export function clusterSeeds(ev: MomentEvent[], gap: number): Seed[] {
  const seeds: Seed[] = []; let cur: MomentEvent[] = [];
  const flush = () => { if (!cur.length) return; const top = cur.reduce((a, b) => (b.strength > a.strength ? b : a)); const kinds = [...new Set(cur.map((x) => x.kind))]; seeds.push({ peakAt: top.t, kinds, strength: clamp01(top.strength + 0.08 * (kinds.length - 1)), events: cur }); cur = []; };
  for (const x of ev) { if (cur.length && x.t - cur[cur.length - 1]!.t > gap) flush(); cur.push(x); } flush(); return seeds;
}

/** setup -> payoff patterns found in the transcript around the peak (keywords are supporting evidence only) */
export function detectPattern(sents: Sentence[], peakAt: number, silence: Interval[], c: MomentCfg): { pattern: Pattern; setupStart: number | null; payoffEnd: number | null } {
  const win = sents.filter((s) => s.end >= peakAt - c.setupLookbackSec && s.start <= peakAt + 14); const none = { pattern: 'none' as Pattern, setupStart: null, payoffEnd: null };
  const pair = (name: Pattern, setup: (s: Sentence) => boolean, payoff: (s: Sentence) => boolean, within = 14) => { for (let i = win.length - 1; i >= 0; i--) { const a = win[i]!; if (!setup(a) || a.start > peakAt + 2) continue; const b = win.slice(i + 1).find((s) => payoff(s) && s.start - a.end <= within); if (b) return { pattern: name, setupStart: a.start, payoffEnd: b.end }; } return null; };
  const isQ = (s: Sentence) => /\?\s*$/.test(s.text); const w = (s: Sentence) => s.text.trim().split(/\s+/).length; const em = (s: Sentence) => scoreText(s.text).emotion;
  const r = pair('question_answer', isQ, (s) => !isQ(s) && w(s) >= 3, 10) ?? pair('mistake_consequence', (s) => P.mistake.test(s.text), (s) => P.conseq.test(s.text) || REACT.test(s.text) || LAUGH.test(s.text), 10)
    ?? pair('challenge_outcome', (s) => P.challenge.test(s.text), (s) => P.result.test(s.text) || P.celeb.test(s.text), 40) ?? pair('attempt_result', (s) => P.attempt.test(s.text), (s) => P.result.test(s.text), 12)
    ?? pair('problem_solution', (s) => P.problem.test(s.text), (s) => P.solution.test(s.text), 20) ?? pair('story_payoff', (s) => P.story.test(s.text), (s) => P.reveal.test(s.text) || P.celeb.test(s.text) || REACT.test(s.text), 25)
    ?? pair('conflict_reaction', (s) => em(s) === 'aggressive', (s) => REACT.test(s.text) || !!em(s), 8) ?? pair('event_celebration', (s) => gamingScore(s.text) > 0, (s) => P.celeb.test(s.text) || LAUGH.test(s.text), 10)
    ?? pair('setup_punchline', (s) => w(s) >= 4 && !em(s) && !LAUGH.test(s.text), (s) => LAUGH.test(s.text) || em(s) === 'funny', 8);
  if (r) return r;
  const sl = silence.find((s) => s.end - s.start >= 1.5 && s.end <= peakAt + 1 && s.end >= peakAt - 6); // quiet build-up then reveal
  return sl ? { pattern: 'suspense_reveal', setupStart: Math.max(0, sl.start - 3), payoffEnd: null } : none;
}

const wordAt = (words: Word[], t: number) => words.find((x) => x.start <= t && x.end > t);
/** 2. EXPAND + boundaries: setup backwards, reaction/payoff forwards, snapped to words > sentences > silence (never mid-word, never blindly to silence). */
function expand(seed: Seed, inp: MomentInput, sents: Sentence[], words: Word[], c: MomentCfg) {
  const pat = sents.length ? detectPattern(sents, seed.peakAt, inp.silence, c) : { pattern: 'none' as Pattern, setupStart: null, payoffEnd: null };
  let a = seed.peakAt - c.preRollSec; let b = seed.peakAt + c.postRollSec;
  if (pat.setupStart !== null) a = Math.min(a, pat.setupStart - 0.2); if (pat.payoffEnd !== null) b = Math.max(b, pat.payoffEnd + 0.3);
  const en = inp.energy; const st = inp.energyStep; const baseAt = (t: number) => (st > 0 && en.length ? en[Math.min(en.length - 1, Math.max(0, Math.floor(t / st)))]! : 0);
  for (let k = 0; k < 4 && sents.length; k++) { const nx = sents.find((s) => s.start >= b - 0.5 && s.start - b <= 1.5); if (!nx || nx.end - a > c.maxSec - 2 || !(REACT.test(nx.text) || LAUGH.test(nx.text) || /!/.test(nx.text) || scoreText(nx.text).emotion || baseAt(nx.start) >= 0.55)) break; b = nx.end + 0.15; } // reaction not finished yet
  a = Math.max(inp.lo, a); b = Math.min(inp.hi, b); let boundary: Moment['boundary'] = 'raw';
  if (sents.length) { // sentence boundaries: if cut inside a sentence, go to its start (setup) / its end (payoff)
    const sa = sents.find((s) => s.start <= a && s.end > a); if (sa && a - sa.start <= 6) { a = Math.max(inp.lo, sa.start - 0.08); boundary = 'sentences'; } else { const nx = sents.find((s) => s.start >= a && s.start - a <= 3); if (nx) { a = Math.max(inp.lo, nx.start - 0.08); boundary = 'sentences'; } }
    const sb = sents.find((s) => s.start < b && s.end >= b); if (sb && sb.end - b <= 6) { b = Math.min(inp.hi, sb.end + 0.15); boundary = 'sentences'; }
    if (words.length) { const wa = wordAt(words, a); if (wa) a = Math.max(inp.lo, wa.start - 0.05); const wb = wordAt(words, b); if (wb) b = Math.min(inp.hi, wb.end + 0.1); boundary = 'words'; }
  } else { const near = (t: number, lo: number, hi: number) => { let best = t, bd = 1.5; for (const s of inp.silence) { const m = (s.start + s.end) / 2; if (m >= lo && m <= hi && Math.abs(m - t) < bd) { bd = Math.abs(m - t); best = m; } } return best; }; const a2 = near(a, inp.lo, seed.peakAt - 1), b2 = near(b, seed.peakAt + 1, inp.hi); if (a2 !== a || b2 !== b) boundary = 'silence'; a = a2; b = b2; }
  let setupLost = false;
  if (b - a > c.maxSec) { const na = b - c.maxSec; setupLost = pat.setupStart !== null && na > pat.setupStart; a = na; const nx = sents.find((s) => s.start >= a - 0.01 && s.start - a <= 3); if (nx) a = nx.start - 0.08; }
  if (b - a < c.minSec) { b = Math.min(inp.hi, a + c.minSec); if (b - a < c.minSec) a = Math.max(inp.lo, b - c.minSec); if (sents.length) { const sb = sents.find((s) => s.start < b && s.end >= b); if (sb && sb.end - b <= 4 && sb.end + 0.15 - a <= c.maxSec) b = Math.min(inp.hi, sb.end + 0.15); } }
  if (b - a < c.minSec * 0.9) return null;
  return { a, b, pat, boundary, setupLost };
}

/** 3. EVALUATE: explainable breakdown; evidence that is not available is excluded (listed in `missing`), never faked */
function evaluate(seed: Seed, x: NonNullable<ReturnType<typeof expand>>, inp: MomentInput, sents: Sentence[], c: MomentCfg): Moment {
  const { a, b, pat } = x; const inW = sents.filter((s) => s.end > a && s.start < b); const text = inW.map((s) => s.text).join(' '); const hasText = sents.length > 0 && text.trim().length > 0;
  const hasMotion = !!inp.motion && inp.motion.values.length > 8; const ext = inp.external?.length ? externalBoost(inp.external, a, b) : null; const evIn = seed.events.filter((e) => e.t >= a && e.t <= b);
  const kindMax = (...k: EventKind[]) => Math.max(0, ...evIn.filter((e) => k.includes(e.kind)).map((e) => e.strength));
  const sc = hasText ? scoreText(text) : null; const g = hasText && inp.gaming ? gamingScore(text) : 0;
  const en = inp.energy.slice(Math.max(0, Math.floor(a / inp.energyStep)), Math.ceil(b / inp.energyStep)); const sil = inp.silence.reduce((n, s) => n + Math.max(0, Math.min(b, s.end) - Math.max(a, s.start)), 0) / Math.max(0.001, b - a);
  const afterPeak = evIn.filter((e) => e.t >= seed.peakAt && (e.kind === 'laughter' || e.kind === 'reaction' || e.kind === 'exclamation'));
  const first = inW[0]?.text ?? ''; const last = inW[inW.length - 1]?.text ?? '';
  const ctx = hasText ? (pat.pattern !== 'none' ? (x.setupLost ? 0.4 : 1) : CONT.test(first) ? 0.2 : 0.7) : null;
  const bd: Record<string, number | null> = {
    interest: hasText || ext !== null ? clamp01(Math.max(kindMax('laughter', 'reaction') , sc?.emotion ? 0.7 : 0, ext ?? 0, g)) : null,
    hook: hasText ? clamp01(Math.max(hookScore(first), kindMax('question') * 0.8, sc ? sc.hook : 0)) : null,
    significance: clamp01(Math.max(seed.strength, g, ext ?? 0)),
    payoff: hasText ? clamp01(pat.pattern !== 'none' ? 0.85 + (pat.payoffEnd !== null ? 0.1 : 0) : payoffScore(last) * 0.6) : null,
    context: ctx,
    uniqueness: 1,
    reaction: hasText ? clamp01(afterPeak.length ? Math.max(...afterPeak.map((e) => e.strength)) : 0) : null,
    audio: en.length ? clamp01(1 - sil) * (0.6 + 0.4 * clamp01(Math.max(...en))) : null,
    visual: hasMotion ? clamp01(Math.max(kindMax('motion_spike', 'scene_burst'), inp.scenes.filter((t) => t >= a && t <= b).length / Math.max(1, (b - a) / 8))) : null,
    editing: clamp01(0.5 * (1 - Math.min(1, Math.abs(b - a - c.targetSec) / c.targetSec)) + 0.5 * (x.boundary === 'words' ? 1 : x.boundary === 'sentences' ? 0.8 : x.boundary === 'silence' ? 0.6 : 0.3)),
  };
  const w = c.weights; let num = 0, den = 0, all = 0; const missing: string[] = [];
  for (const [k, wt] of Object.entries(w)) { all += wt; const v = bd[k]; if (v === null || v === undefined) continue; num += wt * v; den += wt; }
  if (!hasText) missing.push('transcript'); else if (!inp.cues.some((q) => q.words?.length)) missing.push('word_timestamps'); if (!hasMotion) missing.push('visual_motion'); if (ext === null) missing.push('external_signal');
  const coverage = den / all; const evidenceKinds = new Set(seed.kinds.map((k) => (k.startsWith('audio') ? 'audio' : k === 'scene_burst' || k === 'motion_spike' ? 'visual' : k === 'silence_break' ? 'audio' : k === 'coverage' ? 'coverage' : k === 'external' ? 'external' : 'text')));
  let score = clamp01((den ? num / den : 0) * (0.7 + 0.3 * coverage)); const confidence = +clamp01((0.35 + 0.55 * coverage) * (x.boundary === 'raw' ? 0.85 : 1)).toFixed(2);
  const loudnessOnly = evidenceKinds.size === 1 && evidenceKinds.has('audio'); const t = c.tiers; const reasons: string[] = [];
  let tier: Tier = score >= t.exceptional ? 'EXCEPTIONAL' : score >= t.strong ? 'STRONG' : score >= t.conditional ? 'CONDITIONAL' : 'REJECTED';
  if (tier === 'EXCEPTIONAL' && confidence < 0.7) { tier = 'STRONG'; reasons.push('capped at STRONG: not enough evidence for EXCEPTIONAL'); }
  if (loudnessOnly && (tier === 'EXCEPTIONAL' || tier === 'STRONG')) { tier = 'CONDITIONAL'; reasons.push('capped at CONDITIONAL: loudness is the only evidence'); }
  if (x.setupLost && tier !== 'REJECTED') { tier = tier === 'EXCEPTIONAL' ? 'STRONG' : 'CONDITIONAL'; reasons.push('setup does not fit the maximum length'); }
  if (pat.pattern !== 'none') reasons.unshift(`pattern: ${pat.pattern.replace('_', ' → ')}`); for (const k of seed.kinds) reasons.push(k.replace('_', ' '));
  const category = g >= 0.5 ? 'gaming_moment' : (ext ?? 0) >= 0.7 ? 'crowd_reaction' : sc?.emotion ?? (pat.pattern !== 'none' ? 'story' : seed.kinds.includes('audio_surge') || seed.kinds.includes('audio_peak') ? 'high_energy' : seed.kinds.includes('motion_spike') || seed.kinds.includes('scene_burst') ? 'dynamic_visuals' : 'general');
  const top = Object.entries(bd).filter(([, v]) => v !== null).sort((p, q) => (q[1] as number) - (p[1] as number)).slice(0, 3).map(([k, v]) => `${k} ${(v as number).toFixed(2)}`).join(', ');
  return { start: +a.toFixed(2), end: +b.toFixed(2), duration: +(b - a).toFixed(2), tier, score: +score.toFixed(4), confidence, pattern: pat.pattern, kinds: seed.kinds, peakAt: +seed.peakAt.toFixed(2), breakdown: bd, missing, reasons, explanation: `${tier}: ${top}${missing.length ? ` (no evidence: ${missing.join(', ')})` : ''}`, hook: first.slice(0, 140), transcript: text, contextComplete: ctx === null ? null : ctx >= 0.7, boundary: x.boundary, category };
}

const iou = (p: Moment, q: Moment) => { const i = Math.max(0, Math.min(p.end, q.end) - Math.max(p.start, q.start)); return i / Math.max(0.001, p.duration + q.duration - i); };
/** 4. DEDUPE: IoU > dupIoU is a REVIEW trigger. Same event => keep the editorially better one (or the union when it is better and fits); different events stay separate. */
export function dedupeMoments(list: Moment[], c: MomentCfg = DEFAULT_MOMENT_CFG): { kept: Moment[]; merged: number } {
  const kept: Moment[] = []; let merged = 0;
  for (const m of [...list].sort((p, q) => q.score - p.score)) {
    const twin = kept.find((k) => { const o = iou(m, k); const near = Math.abs(m.peakAt - k.peakAt) <= c.distinctMinGapSec; const sim = m.transcript && k.transcript ? similarity(m.transcript, k.transcript) : 0; return (o > c.dupIoU && (near || sim >= 0.4 || (!m.transcript && !k.transcript))) || (o > 0.2 && sim >= 0.6) || (o > 0.3 && near && m.pattern === k.pattern && m.pattern !== 'none'); });
    if (!twin) { const clash = kept.find((k) => Math.min(m.end, k.end) - Math.max(m.start, k.start) > 0.5 * Math.min(m.duration, k.duration)); if (clash) { merged++; continue; } kept.push(m); continue; } // different events may overlap a little, never by more than half
    merged++; twin.mergedFrom = (twin.mergedFrom ?? 1) + 1; twin.breakdown = { ...twin.breakdown, uniqueness: Math.min(1, (twin.breakdown.uniqueness as number) ?? 1) };
    const u0 = Math.min(m.start, twin.start), u1 = Math.max(m.end, twin.end); if (u1 - u0 <= c.maxSec && m.contextComplete && !twin.contextComplete) { twin.start = u0; twin.end = u1; twin.duration = +(u1 - u0).toFixed(2); twin.contextComplete = true; }
  }
  return { kept: kept.sort((p, q) => p.start - q.start), merged };
}

export interface DetectStats { events: number; seeds: number; evaluated: number; merged: number; ms: number; byTier: Record<Tier, number> }
/** Whole pipeline. REJECTED moments are returned too (with their breakdown) so the UI can show why something was not used. */
export function detectMoments(inp: MomentInput, cfg: Partial<MomentCfg> = {}): { moments: Moment[]; stats: DetectStats } {
  const t0 = Date.now(); const c: MomentCfg = { ...DEFAULT_MOMENT_CFG, ...cfg, weights: { ...DEFAULT_MOMENT_CFG.weights, ...(cfg.weights ?? {}) }, tiers: { ...DEFAULT_MOMENT_CFG.tiers, ...(cfg.tiers ?? {}) } };
  const ev = discoverEvents(inp, c); const seeds = clusterSeeds(ev, c.clusterSec); const sents = inp.cues.length ? sentencesFromCues(inp.cues) : []; const words = inp.cues.flatMap((q) => q.words ?? []);
  const ms: Moment[] = []; for (const s of seeds) { if (s.peakAt < inp.lo - 1 || s.peakAt > inp.hi + 1) continue; const x = expand(s, inp, sents, words, c); if (x) ms.push(evaluate(s, x, inp, sents, c)); }
  const d = dedupeMoments(ms, c); const byTier: Record<Tier, number> = { EXCEPTIONAL: 0, STRONG: 0, CONDITIONAL: 0, REJECTED: 0 }; for (const m of d.kept) byTier[m.tier]++;
  return { moments: d.kept, stats: { events: ev.length, seeds: seeds.length, evaluated: ms.length, merged: d.merged, ms: Date.now() - t0, byTier } };
}
