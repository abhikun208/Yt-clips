import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { J } from './draft.ts';
import { probe, speechPieces, type Probe } from './media.ts';
import { parseCues, type Cue, addCues } from './subs.ts';
import { blankDraft, addVideo, writeNewDraft } from './newdraft.ts';
import { newDraftDir } from './draft.ts';

export interface Piece { start: number; end: number; weight: number }
export interface Window { start: number; end: number; score: number }

/**
 * Candidate windows from "pieces" (speech runs or subtitle cues): start at a piece, keep adding pieces while the window stays <= max, and
 * only accept lengths >= min. A window always starts and ends on a piece edge, so a clip never begins or ends in the middle of a sentence.
 * Score = how much talking per second. Best windows are taken greedily without overlap, then returned in time order.
 */
export function pickWindows(pieces: Piece[], o: { count: number; min: number; max: number; gap?: number }): Window[] {
  const ps = [...pieces].sort((a, b) => a.start - b.start); const cands: Window[] = []; const maxGap = o.gap ?? 2_500_000;
  for (let i = 0; i < ps.length; i++) {
    let best: Window | null = null; let weight = 0;
    for (let j = i; j < ps.length; j++) {
      if (j > i && ps[j]!.start - ps[j - 1]!.end > maxGap && ps[j - 1]!.end - ps[i]!.start >= o.min) break; // a long pause after a long-enough run = natural end
      const len = ps[j]!.end - ps[i]!.start; if (len > o.max) break; weight += ps[j]!.weight; if (len >= o.min) best = { start: ps[i]!.start, end: ps[j]!.end, score: weight / (len / 1e6) };
    }
    if (best) cands.push(best);
  }
  const out: Window[] = []; for (const c of cands.sort((a, b) => b.score - a.score)) { if (out.length >= o.count) break; if (!out.some((w) => c.start < w.end && c.end > w.start)) out.push(c); }
  return out.sort((a, b) => a.start - b.start);
}
export function evenWindows(total: number, o: { count: number; min: number; max: number }): Window[] {
  const len = Math.min(o.max, Math.max(o.min, Math.floor(total / Math.max(1, o.count)))); const n = Math.max(1, Math.min(o.count, Math.floor(total / len))); const step = n > 1 ? (total - len) / (n - 1) : 0;
  return Array.from({ length: n }, (_, i) => ({ start: Math.round(i * step), end: Math.round(i * step + len), score: 0 }));
}
const words = (t: string): number => t.split(/\s+/).filter(Boolean).length || Math.ceil([...t].length / 2);

export interface ShortsOptions { source: string; outRoot: string; count: number; min: number; max: number; mode: 'silence' | 'subs' | 'even'; vertical: boolean; subsFile?: string; cues?: Cue[]; name?: string; seed?: J; seedDir?: string; fps?: number; x?: number; probeFn?: (p: string) => Probe; piecesFn?: (p: Probe) => Piece[] }
export interface ShortResult { dir: string; start: number; end: number; subtitles: number }

export function makeShorts(o: ShortsOptions): ShortResult[] {
  const p = (o.probeFn ?? probe)(o.source); if (!p.duration) throw new Error('could not read the length of ' + o.source);
  let cues = o.cues ?? (o.subsFile ? parseCues(readFileSync(o.subsFile, 'utf8')) : []);
  let wins: Window[];
  if (o.mode === 'even') wins = evenWindows(p.duration, o);
  else if (o.mode === 'subs') { if (!cues.length) throw new Error('mode "subs" needs subtitles: pass --subs file.srt'); wins = pickWindows(cues.map((c) => ({ start: c.start, end: c.end, weight: words(c.text) })), o); }
  else { const pcs = (o.piecesFn ? o.piecesFn(p) : speechPieces(o.source, p.duration).map((s) => ({ ...s, weight: (s.end - s.start) / 1e6 }))); wins = pickWindows(pcs, o); if (!wins.length) wins = evenWindows(p.duration, o); }
  if (!wins.length) throw new Error('no usable window found: try a shorter --min or mode even');
  const w = o.vertical ? 1080 : p.width || 1920, h = o.vertical ? 1920 : p.height || 1080; const base = o.name ?? basename(o.source, extname(o.source)); const out: ShortResult[] = [];
  wins.forEach((win, i) => {
    const j = blankDraft({ name: `${base}_short_${String(i + 1).padStart(2, '0')}`, width: w, height: h, fps: o.fps ?? (p.fps || 30), seed: o.seed });
    addVideo(j, p, { srcStart: win.start, srcDur: win.end - win.start, at: 0, fill: o.vertical, x: o.x });
    const inside: Cue[] = cues.filter((c) => c.end > win.start && c.start < win.end).map((c) => ({ start: Math.max(c.start, win.start) - win.start, end: Math.min(c.end, win.end) - win.start, text: c.text }));
    if (inside.length) addCues(j, inside);
    const dir = newDraftDir(o.outRoot, j.name); writeNewDraft(dir, j, [p], o.seedDir); out.push({ dir, start: win.start, end: win.end, subtitles: inside.length });
  });
  return out;
}
