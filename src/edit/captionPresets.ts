// Original caption presets. Inspired by common short-form caption *categories* (tags like Bold, Build, Caps, Box, Karaoke, Glow,
// Outline, Chip, Typewriter, One-word). These are NOT copies of any third-party template or asset.

export type Mode = 'highlight' | 'build' | 'one' | 'karaoke' | 'type';
export type Position = 'bottom' | 'center' | 'top';
export interface Palette { id: string; name: string; base: string; active: string; upcoming: string; outline: string; box: string; emphasis: string }
export interface BaseStyle {
  id: string; name: string; tags: string[]; mode: Mode; position: Position; sizePct: number; caps: boolean; wordsPerChunk: number;
  outlinePct: number; shadowPct: number; box: boolean; glow: boolean; pop: number; showUpcoming: boolean; fontStyle: 'bold' | 'regular';
}
export interface Preset extends BaseStyle { presetId: string; label: string; palette: Palette }

export const PALETTES: Palette[] = [
  { id: 'sun', name: 'Sun', base: '#FFFFFF', active: '#FFE600', upcoming: '#9A9A9A', outline: '#000000', box: '#000000', emphasis: '#FF4D4D' },
  { id: 'coral', name: 'Coral', base: '#FFFFFF', active: '#FF6B5E', upcoming: '#8E8E8E', outline: '#000000', box: '#111111', emphasis: '#FFE600' },
  { id: 'mint', name: 'Mint', base: '#FFFFFF', active: '#3DFFB0', upcoming: '#8A9A94', outline: '#00201A', box: '#00201A', emphasis: '#FFE600' },
  { id: 'sky', name: 'Sky', base: '#FFFFFF', active: '#4FC3FF', upcoming: '#8A97A3', outline: '#001A2E', box: '#001A2E', emphasis: '#FFE600' },
  { id: 'magenta', name: 'Magenta', base: '#FFFFFF', active: '#FF3DCB', upcoming: '#9A8A96', outline: '#2A0020', box: '#2A0020', emphasis: '#FFE600' },
  { id: 'gold', name: 'Gold', base: '#FFF4D6', active: '#FFB800', upcoming: '#A39A82', outline: '#2B1A00', box: '#2B1A00', emphasis: '#FF4D4D' },
];

export const BASES: BaseStyle[] = [
  { id: 'classic', name: 'Classic', tags: ['Bold', 'Outline'], mode: 'highlight', position: 'bottom', sizePct: 4.2, caps: false, wordsPerChunk: 3, outlinePct: 0.45, shadowPct: 0.2, box: false, glow: false, pop: 112, showUpcoming: true, fontStyle: 'bold' },
  { id: 'build', name: 'Build', tags: ['Bold', 'Build', 'Caps'], mode: 'build', position: 'center', sizePct: 4.6, caps: true, wordsPerChunk: 4, outlinePct: 0.5, shadowPct: 0.2, box: false, glow: false, pop: 108, showUpcoming: false, fontStyle: 'bold' },
  { id: 'build-grey', name: 'Build Grey-Ahead', tags: ['Build', 'Caps'], mode: 'build', position: 'center', sizePct: 4.4, caps: true, wordsPerChunk: 4, outlinePct: 0.45, shadowPct: 0.2, box: false, glow: false, pop: 106, showUpcoming: true, fontStyle: 'bold' },
  { id: 'one-word', name: 'One Word', tags: ['Bold', 'Caps'], mode: 'one', position: 'center', sizePct: 8.5, caps: true, wordsPerChunk: 1, outlinePct: 0.7, shadowPct: 0.3, box: false, glow: false, pop: 118, showUpcoming: false, fontStyle: 'bold' },
  { id: 'mega', name: 'Mega', tags: ['Bold', 'Caps', 'Outline'], mode: 'one', position: 'center', sizePct: 11, caps: true, wordsPerChunk: 1, outlinePct: 1.0, shadowPct: 0.4, box: false, glow: false, pop: 125, showUpcoming: false, fontStyle: 'bold' },
  { id: 'karaoke', name: 'Karaoke', tags: ['Karaoke', 'Bold'], mode: 'karaoke', position: 'bottom', sizePct: 4.2, caps: false, wordsPerChunk: 4, outlinePct: 0.45, shadowPct: 0.2, box: false, glow: false, pop: 100, showUpcoming: true, fontStyle: 'bold' },
  { id: 'chip', name: 'Chip', tags: ['Box', 'Chip'], mode: 'highlight', position: 'bottom', sizePct: 4.0, caps: false, wordsPerChunk: 3, outlinePct: 0.9, shadowPct: 0, box: true, glow: false, pop: 108, showUpcoming: true, fontStyle: 'bold' },
  { id: 'glow', name: 'Glow', tags: ['Glow', 'Outline'], mode: 'highlight', position: 'bottom', sizePct: 4.2, caps: false, wordsPerChunk: 3, outlinePct: 0.35, shadowPct: 0, box: false, glow: true, pop: 110, showUpcoming: true, fontStyle: 'bold' },
  { id: 'hard-shadow', name: 'Hard Shadow', tags: ['Bold', 'Shadow'], mode: 'highlight', position: 'bottom', sizePct: 4.4, caps: true, wordsPerChunk: 3, outlinePct: 0.1, shadowPct: 0.7, box: false, glow: false, pop: 108, showUpcoming: true, fontStyle: 'bold' },
  { id: 'typewriter', name: 'Typewriter', tags: ['Typewriter'], mode: 'type', position: 'bottom', sizePct: 3.8, caps: false, wordsPerChunk: 5, outlinePct: 0.35, shadowPct: 0.15, box: false, glow: false, pop: 100, showUpcoming: false, fontStyle: 'regular' },
  { id: 'pop-top', name: 'Pop Top', tags: ['Bold', 'Caps'], mode: 'highlight', position: 'top', sizePct: 4.4, caps: true, wordsPerChunk: 2, outlinePct: 0.5, shadowPct: 0.2, box: false, glow: false, pop: 125, showUpcoming: true, fontStyle: 'bold' },
  { id: 'minimal', name: 'Minimal', tags: ['Clean'], mode: 'highlight', position: 'bottom', sizePct: 3.4, caps: false, wordsPerChunk: 5, outlinePct: 0.25, shadowPct: 0.15, box: false, glow: false, pop: 100, showUpcoming: true, fontStyle: 'regular' },
];

export const PRESETS: Preset[] = BASES.flatMap((b) => PALETTES.map((p) => ({ ...b, presetId: `${b.id}-${p.id}`, label: `${b.name} · ${p.name}`, palette: p })));
export const DEFAULT_PRESET = 'classic-sun';
export const getPreset = (id: string): Preset | undefined => PRESETS.find((p) => p.presetId === id);

// ---- Script handling (Hindi/Indian languages) ----
export type Script = 'latin' | 'devanagari' | 'tamil' | 'telugu' | 'bengali' | 'gujarati' | 'kannada' | 'malayalam' | 'gurmukhi' | 'odia' | 'arabic';
const RANGES: [Script, RegExp][] = [
  ['devanagari', /[ऀ-ॿ]/g], ['bengali', /[ঀ-৿]/g], ['gurmukhi', /[਀-੿]/g], ['gujarati', /[઀-૿]/g],
  ['odia', /[଀-୿]/g], ['tamil', /[஀-௿]/g], ['telugu', /[ఀ-౿]/g], ['kannada', /[ಀ-೿]/g], ['malayalam', /[ഀ-ൿ]/g], ['arabic', /[؀-ۿ]/g],
];
/** Dominant non-Latin script if it makes up >= 20% of letters, else 'latin'. */
export function detectScript(text: string): Script {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (!letters) return 'latin';
  let best: Script = 'latin'; let n = 0;
  for (const [s, re] of RANGES) { const c = (text.match(re) ?? []).length; if (c > n) { n = c; best = s; } }
  return n / letters >= 0.2 ? best : 'latin';
}
/** Font family candidates per script; the first one installed wins (see resolveFont). Install fonts-noto-core in Docker/VPS. */
export const SCRIPT_FONTS: Record<Script, string[]> = {
  latin: ['Poppins', 'Montserrat', 'Noto Sans', 'DejaVu Sans'],
  devanagari: ['Noto Sans Devanagari', 'Mukta', 'Hind', 'Lohit Devanagari', 'FreeSans', 'FreeSerif', 'DejaVu Sans'],
  tamil: ['Noto Sans Tamil', 'Lohit Tamil', 'FreeSerif', 'DejaVu Sans'], telugu: ['Noto Sans Telugu', 'Lohit Telugu', 'DejaVu Sans'],
  bengali: ['Noto Sans Bengali', 'Lohit Bengali', 'FreeSerif', 'DejaVu Sans'], gujarati: ['Noto Sans Gujarati', 'Lohit Gujarati', 'FreeSerif', 'DejaVu Sans'],
  kannada: ['Noto Sans Kannada', 'Lohit Kannada', 'DejaVu Sans'], malayalam: ['Noto Sans Malayalam', 'Lohit Malayalam', 'DejaVu Sans'],
  gurmukhi: ['Noto Sans Gurmukhi', 'Lohit Gurmukhi', 'FreeSerif', 'DejaVu Sans'], odia: ['Noto Sans Oriya', 'Lohit Odia', 'DejaVu Sans'],
  arabic: ['Noto Naskh Arabic', 'Noto Sans Arabic', 'DejaVu Sans'],
};
