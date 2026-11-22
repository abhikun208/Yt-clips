import type { Candidate } from './select.ts';

/**
 * Post-selection quality gate (Prompt1 Shorts engine): drops duplicates / repeated hooks, clips that start by continuing an earlier sentence
 * (missing context), clips that stop mid-sentence (bad boundary) and borderline clips with no payoff. It can drop EVERYTHING: 0 Shorts is
 * a valid result. Series parts and whole-video clips are never gated. Pure: no I/O, no editing.
 */
const CONT = /^\s*(and|but|because|which|aur|lekin|kyunki|toh phir)\b/i;
const DANGLING_END = /\b(and|but|the|a|an|to|of|with|for|because|aur|ya|ka|ki|ke|ko|se|me|mein|ke liye)\s*[,.…]*\s*$/i;
const words = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const shingles = (s: string, n = 3): Set<string> => { const w = words(s); const out = new Set<string>(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; };
export function similarity(a: string, b: string): number { const x = shingles(a), y = shingles(b); if (!x.size || !y.size) return 0; let i = 0; for (const s of x) if (y.has(s)) i++; return i / (x.size + y.size - i); }

export interface Dropped { c: Candidate; reason: 'duplicate' | 'repeated_hook' | 'missing_context' | 'bad_boundary' | 'weak_payoff' }
export function gateCandidates(cands: Candidate[], o: { minScore: number; skip?: (c: Candidate) => boolean; dupAt?: number }): { keep: Candidate[]; dropped: Dropped[] } {
  const dupAt = o.dupAt ?? 0.6; const keep: Candidate[] = []; const dropped: Dropped[] = [];
  for (const c of [...cands].sort((a, b) => b.score - a.score)) { // best first, so the weaker twin is the one dropped
    if (o.skip?.(c)) { keep.push(c); continue; }
    const tx = c.transcript?.trim() ?? ''; const hasText = words(tx).length >= 8; let why: Dropped['reason'] | null = null;
    if (hasText) {
      const hk = words(c.hook ?? '').join(' ');
      if (keep.some((k) => !o.skip?.(k) && k.transcript && similarity(k.transcript, tx) >= dupAt)) why = 'duplicate';
      else if (hk.split(' ').length >= 4 && keep.some((k) => words(k.hook ?? '').join(' ') === hk)) why = 'repeated_hook';
      else if (CONT.test(tx)) why = 'missing_context';
      else if (DANGLING_END.test(tx)) why = 'bad_boundary';
      else if ((c.signals?.payoff ?? 1) <= 0.2 && (c.signals?.hookLine ?? 1) === 0 && c.score < o.minScore * 1.15) why = 'weak_payoff';
    }
    if (why) dropped.push({ c, reason: why }); else keep.push(c);
  }
  return { keep: keep.sort((a, b) => a.start - b.start), dropped };
}
