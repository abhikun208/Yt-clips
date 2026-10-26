import type { Cue, Word } from '../analysis/transcript.ts';
import { HOOK_WORDS } from '../analysis/keywords.ts';
import { getPreset, DEFAULT_PRESET, detectScript, SCRIPT_FONTS, type Preset, type Script } from './captionPresets.ts';

const hms = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
/** '#RRGGBB' -> ASS '&HAABBGGRR' (alpha 00 = opaque). */
/** Amounts and numbers pop in the emphasis colour ("16 lakh", "₹30", "50%", "1v4"). */
const NUMBERISH = /\d|^(lakh|lakhs|crore|crores|million|billion|thousand|hazaar|rupees?|rs\.?|₹|\$)$/i;
export const assColor = (hex: string, alpha = 0): string => {
  const h = hex.replace('#', '');
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
const inl = (hex: string) => assColor(hex).replace('&H00', '&H') + '&'; // inline form &HBBGGRR&
const clean = (s: string) => s.replace(/[\\{}]/g, '').replace(/\r?\n/g, ' ').trim();

interface TWord { w: string; a: number; b: number }
export interface CaptionResult { ass: string; timing: 'measured' | 'approximate' | 'none'; font: string; script: Script; presetId: string; warnings: string[] }
export interface CaptionOpts {
  width: number; height: number; preset?: string; emphasis?: string[]; resolveFont?: (candidates: string[]) => string | undefined; titleColor?: string;
}

/** Word timeline for the clip window. Uses real per-word timestamps when the cue has them; else splits by word length (approximate). */
export function timeWords(cues: Cue[], start: number, end: number): { words: TWord[]; timing: 'measured' | 'approximate' | 'none' } {
  const out: TWord[] = []; let measured = 0; let approx = 0;
  for (const c of cues) {
    if (c.end <= start || c.start >= end) continue;
    const real: Word[] | undefined = c.words?.length ? c.words : undefined;
    if (real) {
      for (const w of real) {
        const a = Math.max(w.start, start) - start, b = Math.min(w.end, end) - start;
        const t = clean(w.text); if (b > a && t) { out.push({ w: t, a, b }); measured++; }
      }
    } else {
      const s = Math.max(c.start, start) - start, e = Math.min(c.end, end) - start;
      const toks = clean(c.text).split(/\s+/).filter(Boolean); if (e <= s || !toks.length) continue;
      const total = toks.reduce((n, t) => n + t.length + 1, 0); let t0 = s;
      for (const t of toks) { const d = ((t.length + 1) / total) * (e - s); out.push({ w: t, a: t0, b: t0 + d }); t0 += d; approx++; }
    }
  }
  out.sort((x, y) => x.a - y.a);
  // Guarantee monotonic, non-overlapping words.
  for (let i = 1; i < out.length; i++) if (out[i]!.a < out[i - 1]!.b) out[i - 1]!.b = Math.max(out[i - 1]!.a + 0.03, out[i]!.a);
  return { words: out, timing: out.length === 0 ? 'none' : measured >= approx ? 'measured' : 'approximate' };
}

function chunkWords(words: TWord[], n: number): TWord[][] {
  const chunks: TWord[][] = []; let cur: TWord[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (cur.length && (cur.length >= n || w.a - prev!.b > 0.7 || /[.!?।]$/.test(prev!.w))) { chunks.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function pickFont(script: Script, resolve?: CaptionOpts['resolveFont']): { font: string; warning?: string } {
  const cands = SCRIPT_FONTS[script];
  if (!resolve) return { font: cands[0]! };
  const f = resolve(cands);
  return f ? { font: f } : { font: cands[cands.length - 1]!, warning: `no installed font for ${script} script (tried ${cands.slice(0, 3).join(', ')}…): glyphs may be missing. Install fonts-noto-core.` };
}

/** Build a complete ASS document: styled word-synchronized captions + optional animated title. Pure function (no I/O). */
export function buildStyledAss(cues: Cue[], clipStart: number, clipEnd: number, title: string | null, o: CaptionOpts): CaptionResult {
  const warnings: string[] = [];
  let preset: Preset | undefined = getPreset(o.preset ?? DEFAULT_PRESET);
  if (!preset) { warnings.push(`unknown caption preset "${o.preset}", using ${DEFAULT_PRESET}`); preset = getPreset(DEFAULT_PRESET)!; }
  const { words, timing } = timeWords(cues, clipStart, clipEnd);
  const dur = clipEnd - clipStart;
  const script = detectScript(words.map((w) => w.w).join(' ') + ' ' + (title ?? ''));
  const f = pickFont(script, o.resolveFont); if (f.warning) warnings.push(f.warning);
  const H = o.height, p = preset, pal = p.palette;
  const size = Math.round((H * p.sizePct) / 100), outline = Math.max(2, Math.round((H * p.outlinePct) / 100)), shadow = Math.round((H * p.shadowPct) / 100);
  const align = p.position === 'bottom' ? 2 : p.position === 'center' ? 5 : 8;
  const marginV = p.position === 'bottom' ? Math.round(H * 0.2) : p.position === 'top' ? Math.round(H * 0.16) : 0;
  const bold = p.fontStyle === 'bold' ? -1 : 0;
  const capStyle = p.mode === 'karaoke'
    ? { primary: pal.active, secondary: pal.base } : { primary: pal.base, secondary: pal.active };
  const borderStyle = p.box ? 3 : 1;
  const outColor = p.box ? assColor(pal.box, 0x30) : p.glow ? assColor(pal.active, 0x60) : assColor(pal.outline);
  const style = `Style: Cap,${f.font},${size},${assColor(capStyle.primary)},${assColor(capStyle.secondary)},${outColor},${assColor('#000000', 0x70)},${bold},0,${p.underline ? -1 : 0},0,100,100,0,0,${borderStyle},${p.glow ? Math.round(outline * 1.8) : outline},${shadow},${align},60,60,${marginV},1`;
  const tSize = Math.round(H * 0.036);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${o.width}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style}
Style: Title,${f.font},${tSize},${assColor(o.titleColor ?? pal.active)},${assColor(pal.active)},${assColor(pal.outline)},${assColor('#000000', 0x70)},-1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(H * 0.004))},3,8,60,60,${Math.round(H * 0.06)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  if (title) lines.push(`Dialogue: 1,${hms(0.2)},${hms(Math.min(3.5, dur))},Title,,0,0,0,,{\\fad(200,300)\\fscx80\\fscy80\\t(0,200,\\fscx100\\fscy100)}${clean(title)}`);

  const emph = new Set([...HOOK_WORDS, ...(o.emphasis ?? [])].map((x) => x.toLowerCase()));
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const T = (s: string) => (p.caps ? s.toLocaleUpperCase() : s);
  // Per-word font fallback: a word whose script differs from the clip's dominant script (e.g. English inside Hindi) gets its own installed font via an inline \fn override.
  const wordFont = (w: string): string | null => { if (!/\p{L}/u.test(w)) return null; const sc = detectScript(w); if (sc === script) return null; const fx = pickFont(sc, o.resolveFont); return fx.warning || fx.font === f.font ? null : fx.font; };
  const F = (w: string) => { const fn = wordFont(w); const t = T(w); return fn ? `{\\fn${fn}}${t}{\\fn${f.font}}` : t; };
  const glow = p.glow ? '{\\blur5}' : '';
  const colorFor = (w: TWord, state: 'active' | 'spoken' | 'upcoming') => state === 'active' ? pal.active : state === 'upcoming' ? pal.upcoming : (emph.has(norm(w.w)) || NUMBERISH.test(w.w)) && norm(w.w) ? pal.emphasis : pal.base;
  const popTag = (pct: number) => (pct === 100 ? '' : `\\fscx100\\fscy100\\t(0,90,\\fscx${pct}\\fscy${pct})\\t(90,200,\\fscx100\\fscy100)`);
  const render = (chunk: TWord[], k: number, upto: number, showUpcoming: boolean): string => chunk.slice(0, upto).map((w, i) => {
    const state = i === k ? 'active' : i < k ? 'spoken' : 'upcoming';
    if (state === 'upcoming' && !showUpcoming) return '';
    const tags = state === 'active' ? `{\\c${inl(colorFor(w, state))}${popTag(p.pop)}}` : `{\\c${inl(colorFor(w, state))}}`;
    return `${tags}${F(w.w)}`;
  }).filter(Boolean).join(' ');

  const chunks = chunkWords(words, p.wordsPerChunk);
  chunks.forEach((chunk, ci) => {
    const nextStart = chunks[ci + 1]?.[0]?.a ?? Infinity;
    const last = chunk[chunk.length - 1]!;
    const chunkEnd = Math.min(nextStart - 0.02, last.b + 0.25, dur);
    if (p.mode === 'karaoke') {
      const parts = chunk.map((w, i) => `{\\kf${Math.max(1, Math.round(((chunk[i + 1]?.a ?? chunkEnd) - w.a) * 100))}}${F(w.w)}`).join(' ');
      lines.push(`Dialogue: 0,${hms(chunk[0]!.a)},${hms(Math.max(chunkEnd, chunk[0]!.a + 0.05))},Cap,,0,0,0,,${glow}{\\fad(40,0)}${parts}`);
      return;
    }
    chunk.forEach((w, k) => {
      const a = w.a; const b = k + 1 < chunk.length ? chunk[k + 1]!.a : Math.max(chunkEnd, w.a + 0.05);
      if (b - a < 0.03) return;
      let text: string;
      if (p.mode === 'one') text = `{\\fad(25,0)\\c${inl(pal.active)}\\fscx70\\fscy70\\t(0,110,\\fscx${p.pop}\\fscy${p.pop})\\t(110,200,\\fscx100\\fscy100)}${F(w.w)}`;
      else if (p.mode === 'type') text = chunk.slice(0, k + 1).map((x) => F(x.w)).join(' ');
      else if (p.mode === 'build') text = render(chunk, k, p.showUpcoming ? chunk.length : k + 1, p.showUpcoming);
      else text = render(chunk, k, chunk.length, true);
      lines.push(`Dialogue: 0,${hms(a)},${hms(b)},Cap,,0,0,0,,${glow}${text}`);
    });
  });
  return { ass: head + lines.join('\n') + '\n', timing, font: f.font, script, presetId: p.presetId, warnings };
}
