/**
 * Hook candidate engine: several scored hook lines for one clip, every one of them VERBATIM from what is actually said in the clip (so a hook can
 * never promise something the clip does not deliver). It does not edit video. A strong line from later in the clip is flagged `teaser` so the
 * owner/editor can show the payoff in the first 1-2 seconds; nothing is reordered here. If the clip has too little speech it returns fewer
 * candidates (or none) instead of padding with templates.
 */
import { hookScore } from '../analysis/textsignals.ts';
import type { Sentence } from '../analysis/textsignals.ts';
import { scoreText } from '../analysis/keywords.ts';

export interface HookCandidate { text: string; score: number; source: 'opening' | 'sentence' | 'clause' | 'teaser'; atSec: number | null; reasons: string[] }
export interface HookResult { candidates: HookCandidate[]; best: HookCandidate | null; slowIntro: boolean; note: string }
const clean = (s: string) => s.replace(/[#@]\S+/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export function hookCandidates(sentences: Sentence[], o: { max?: number; maxWords?: number } = {}): HookResult {
  const maxWords = o.maxWords ?? 9; const sents = sentences.filter((s) => s.text.trim().split(/\s+/).length >= 3).slice(0, 14);
  const transcript = norm(sentences.map((s) => s.text).join(' ')); if (!sents.length) return { candidates: [], best: null, slowIntro: false, note: 'too little speech: no honest hook can be built (nothing invented)' };
  const raw: { text: string; src: HookCandidate['source']; at: number; idx: number }[] = [];
  sents.forEach((s, i) => {
    const t = clean(s.text); const words = t.split(' '); if (words.length < 3) return;
    raw.push({ text: words.length > maxWords ? words.slice(0, maxWords).join(' ') : t, src: i === 0 ? 'opening' : 'sentence', at: s.start, idx: i });
    if (words.length > maxWords) for (const cl of t.split(/\s*[,;:—–]\s+|\s+-\s+/)) { const w = cl.split(' '); if (w.length >= 3 && w.length <= maxWords && cl !== t) raw.push({ text: cl.trim(), src: 'clause', at: s.start, idx: i }); }
  });
  const seen = new Set<string>(); const cands: HookCandidate[] = [];
  for (const r of raw) {
    const n = norm(r.text); if (!n || seen.has(n) || !transcript.includes(n)) continue; seen.add(n); // truthfulness: must be said in the clip
    const base = hookScore(r.text); const emo = scoreText(r.text).emotion ? 0.1 : 0; const short = r.text.length <= 56 ? 0.15 : 0; const open = r.src === 'opening' ? 0.1 : 0;
    const reasons = [base >= 0.5 ? 'question/claim/number opening' : '', emo ? 'emotion wording' : '', short ? 'short enough for the screen' : '', open ? 'already the first thing said' : ''].filter(Boolean);
    cands.push({ text: r.text, score: +Math.min(1.5, base + emo + short + open).toFixed(3), source: r.src, atSec: r.src === 'opening' ? null : +r.at.toFixed(2), reasons });
  }
  const opening = cands.find((c) => c.source === 'opening'); const openScore = opening?.score ?? 0;
  for (const c of cands) if (c.source !== 'opening' && c.atSec !== null && c.score >= openScore + 0.15 && sents.findIndex((s) => norm(s.text).includes(norm(c.text))) >= 2) { c.source = 'teaser'; c.reasons.push('stronger than the opening: show this payoff in the first 1-2 seconds'); }
  cands.sort((a, b) => b.score - a.score); const top = cands.slice(0, o.max ?? 8); const slowIntro = !!opening && hookScore(opening.text) < 0.2;
  return { candidates: top, best: top[0] ?? null, slowIntro, note: top.length >= 5 ? `${top.length} hook candidates, all verbatim from the clip` : `only ${top.length} distinct honest hook line(s) exist in this clip (not padded with templates)` };
}
