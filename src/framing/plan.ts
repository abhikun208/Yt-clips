/**
 * Framing planner (Prompt1 Shorts engine): PURE, separate from the locked editing pipeline (nothing here is wired into render/filters).
 * Two jobs, both producing a plan that a renderer could follow later:
 *  1) planLayout: from per-sample face detections (+ optional "speaking" energy) choose single / split / trio / grid / fit per time span with
 *     hysteresis, so the layout never flickers and the active speaker is followed smoothly.
 *  2) safeCrop: choose a 9:16 crop window of a 16:9 frame that does NOT cut protected regions (HUD, minimap, kill feed, facecam); when no
 *     window can keep them all it says so (caller should use the blur-fit layout) instead of silently cropping them away.
 */
export interface Face { x: number; y: number; w: number; h: number; /** 0..1 how much this face is speaking right now (audio/lip energy); optional */ speaking?: number }
export interface Sample { t: number; faces: Face[] }
export type LayoutKind = 'fit' | 'single' | 'split' | 'trio' | 'grid';
export interface Span { start: number; end: number; layout: LayoutKind; /** centre X (0..1) of the face(s) the crop should follow; one per tile */ focus: number[] }

const kindFor = (n: number): LayoutKind => (n <= 0 ? 'fit' : n === 1 ? 'single' : n === 2 ? 'split' : n === 3 ? 'trio' : 'grid');
const cx = (f: Face) => Math.min(1, Math.max(0, f.x + f.w / 2));
const MIN_FACE = 0.04; // ignore specks (fraction of frame width)

/** Faces that count at a sample: big enough, and (when speaking data exists) either speaking or among the largest. */
function active(s: Sample, maxTiles: number): Face[] {
  const big = s.faces.filter((f) => f.w >= MIN_FACE).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, maxTiles);
  return big.sort((a, b) => a.x - b.x); // left-to-right = stable tile order
}

export function planLayout(samples: Sample[], o: { minSpanSec?: number; maxTiles?: number; speakerOnly?: boolean } = {}): Span[] {
  const minSpan = o.minSpanSec ?? 2; const maxTiles = Math.max(1, Math.min(4, o.maxTiles ?? 2));
  const pts = samples.filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t); if (!pts.length) return [];
  // 1) raw per-sample decision. speakerOnly: when anybody is speaking, follow only the speaker(s) (podcast cut-to-speaker behaviour)
  const raw = pts.map((s) => { let f = active(s, maxTiles); if (o.speakerOnly && f.some((x) => (x.speaking ?? 0) > 0.3)) f = f.filter((x) => (x.speaking ?? 0) > 0.3).slice(0, 1); return { t: s.t, kind: kindFor(f.length), focus: f.map(cx) }; });
  // 2) group equal kinds into spans
  let spans: Span[] = []; for (let i = 0; i < raw.length; i++) { const r = raw[i]!; const end = raw[i + 1]?.t ?? r.t + 0.5; const last = spans[spans.length - 1];
    if (last && last.layout === r.kind) { last.end = end; last.focus = r.focus.map((v, k) => +(((last.focus[k] ?? v) * 0.6 + v * 0.4)).toFixed(3)); } else spans.push({ start: r.t, end, layout: r.kind, focus: r.focus.map((v) => +v.toFixed(3)) }); }
  // 3) hysteresis: a span shorter than minSpan is absorbed by its longer neighbour (no flicker)
  for (let guard = 0; guard < 50; guard++) { const i = spans.findIndex((s, k) => s.end - s.start < minSpan && spans.length > 1 && !(k === 0 && k === spans.length - 1)); if (i < 0) break;
    const prev = spans[i - 1], next = spans[i + 1]; const into = !next || (prev && prev.end - prev.start >= next.end - next.start) ? prev! : next!; const cur = spans[i]!;
    into.start = Math.min(into.start, cur.start); into.end = Math.max(into.end, cur.end); spans.splice(i, 1);
    spans = spans.reduce<Span[]>((acc, s) => { const l = acc[acc.length - 1]; if (l && l.layout === s.layout) { l.end = s.end; return acc; } acc.push(s); return acc; }, []); }
  return spans;
}

export interface Rect { x: number; y: number; w: number; h: number } // fractions of the full frame
export interface Crop { x: number; w: number; ok: boolean; cut: Rect[]; note: string }
/** 9:16 window inside a 16:9 frame: width fraction = (9/16)/(16/9) ≈ 0.316. Prefers `prefer` (e.g. gameplay centre) but moves to keep protected rects whole. */
export function safeCrop(protect: Rect[], prefer = 0.5, o: { frameAspect?: number } = {}): Crop {
  const w = +((9 / 16) / (o.frameAspect ?? 16 / 9)).toFixed(4); const lo = 0, hi = 1 - w;
  const cuts = (x: number) => protect.filter((r) => { const a = Math.max(x, r.x), b = Math.min(x + w, r.x + r.w); const inter = Math.max(0, b - a); return inter > 0 && inter < r.w - 1e-6; }); // partly inside = cut (fully in or fully out is fine)
  const cands = new Set<number>([Math.min(hi, Math.max(lo, prefer - w / 2))]); for (const r of protect) { cands.add(Math.min(hi, Math.max(lo, r.x))); cands.add(Math.min(hi, Math.max(lo, r.x + r.w - w))); }
  let best = { x: [...cands][0]!, cut: cuts([...cands][0]!) }; for (const x of cands) { const c = cuts(x); const better = c.length < best.cut.length || (c.length === best.cut.length && Math.abs(x + w / 2 - prefer) < Math.abs(best.x + w / 2 - prefer)); if (better) best = { x, cut: c }; }
  return { x: +best.x.toFixed(4), w, ok: best.cut.length === 0, cut: best.cut, note: best.cut.length ? `no 9:16 window keeps all ${protect.length} protected regions whole (${best.cut.length} would be cut): use the blur-fit layout` : 'all protected regions kept whole' };
}
