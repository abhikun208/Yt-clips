/**
 * Content-specific edit recipes + context-aware SFX/music/B-roll decisions (pure; NOT wired into src/edit/render.ts yet, a render hook needs owner approval).
 * A recipe only *proposes* values for options that the editing pipeline already has (zoom, glow, jump cuts, speed ramp, pace, SFX, music, B-roll);
 * `applyRecipe` fills ONLY the options the owner left undefined, so manual settings always win. Unknown content type -> null -> nothing changes.
 * These mappings are editing heuristics, not measured results: they are not verified to improve retention.
 */
export interface StyleRecipe {
  zoom: boolean; glow: boolean; emphasisZoom: boolean; jumpCuts: boolean; speedRamp: boolean; beats: boolean;
  pace: 'relaxed' | 'medium' | 'fast';
  /** which cue kinds may get a synthesised sound effect */ sfx: { whoosh: CueKind[]; pop: CueKind[] };
  music: { allowed: boolean; volume: number };
  /** never: no B-roll; noFaceOnly: only while no face is on screen; topic: also as topic cutaways */ bRoll: 'never' | 'noFaceOnly' | 'topic';
  silenceTrim: 'off' | 'light' | 'normal'; reason: string;
}
export type CueKind = 'hook' | 'emphasis' | 'punchline' | 'kill' | 'reveal';
export interface Cue { t: number; kind: CueKind }
export type StyleKey = 'zoom' | 'glow' | 'emphasisZoom' | 'jumpCuts' | 'speedRamp' | 'beats' | 'pace';

const base: Omit<StyleRecipe, 'reason'> = { zoom: false, glow: false, emphasisZoom: false, jumpCuts: false, speedRamp: false, beats: false, pace: 'medium', sfx: { whoosh: [], pop: [] }, music: { allowed: false, volume: 0.15 }, bRoll: 'never', silenceTrim: 'light' };
const R = (o: Partial<Omit<StyleRecipe, 'reason'>>, reason: string): StyleRecipe => ({ ...base, ...o, reason });
const TYPES: Record<string, StyleRecipe> = {
  gaming: R({ zoom: true, emphasisZoom: true, jumpCuts: true, speedRamp: true, beats: true, pace: 'fast', sfx: { whoosh: ['hook', 'reveal'], pop: ['kill', 'emphasis'] }, music: { allowed: true, volume: 0.15 }, silenceTrim: 'normal' }, 'gaming: fast pace, zoom + SFX on kills/reveals'),
  comedy: R({ zoom: true, emphasisZoom: true, jumpCuts: true, pace: 'fast', sfx: { whoosh: [], pop: ['punchline'] }, music: { allowed: true, volume: 0.12 }, silenceTrim: 'normal' }, 'comedy: tight cuts, a pop only on the punchline'),
  reaction: R({ jumpCuts: true, pace: 'medium', sfx: { whoosh: [], pop: ['punchline', 'reveal'] }, silenceTrim: 'light' }, 'reaction: keep the source audio clear, no music'),
  podcast: R({ pace: 'relaxed', silenceTrim: 'light' }, 'podcast: natural speech, no effects, no music over voices'),
  educational: R({ pace: 'medium', bRoll: 'topic', silenceTrim: 'light' }, 'educational: clarity first, topic B-roll, no SFX'),
  vlog: R({ glow: true, pace: 'medium', sfx: { whoosh: ['hook'], pop: [] }, music: { allowed: true, volume: 0.2 }, bRoll: 'noFaceOnly' }, 'vlog: light music, whoosh on the hook, B-roll only without a face'),
  story: R({ pace: 'relaxed', music: { allowed: true, volume: 0.12 }, bRoll: 'noFaceOnly', silenceTrim: 'off' }, 'story: slow pace, quiet music, no SFX, keep the pauses'),
};
/** null = no recipe for this type: the caller must leave every option exactly as it is today. Sad/dialogue mood silences SFX. */
export function recipeFor(type: string | null | undefined, mood?: string): StyleRecipe | null {
  const r = TYPES[String(type ?? '')]; if (!r) return null;
  return /^(sad|dialogue)$/.test(mood ?? '') ? { ...r, sfx: { whoosh: [], pop: [] }, reason: `${r.reason}; ${mood} mood: SFX off` } : { ...r, sfx: { whoosh: [...r.sfx.whoosh], pop: [...r.sfx.pop] }, music: { ...r.music } };
}
/** Fills ONLY keys the owner left undefined (manual settings always win). Returns the filled keys so the caller can log them. */
export function applyRecipe<T extends Partial<Record<StyleKey, unknown>>>(owner: T, r: StyleRecipe): { options: T & Partial<Record<StyleKey, boolean | string>>; filled: StyleKey[] } {
  const o = { ...owner } as Record<string, unknown>; const filled: StyleKey[] = [];
  for (const k of ['zoom', 'glow', 'emphasisZoom', 'jumpCuts', 'speedRamp', 'beats', 'pace'] as StyleKey[]) if (o[k] === undefined) { o[k] = r[k]; filled.push(k); }
  return { options: o as T & Partial<Record<StyleKey, boolean | string>>, filled };
}
/** Context-aware SFX timing: only the cue kinds the recipe allows, at least `gap` s apart, capped like buildAudioGraph (4 whoosh / 6 pop). */
export function cuePlan(r: StyleRecipe, cues: Cue[], o: { gap?: number } = {}): { whoosh: number[]; pop: number[] } {
  const gap = o.gap ?? 1.2; const out = { whoosh: [] as number[], pop: [] as number[] }; let last = -Infinity;
  for (const c of [...cues].filter((x) => Number.isFinite(x.t) && x.t >= 0).sort((a, b) => a.t - b.t)) {
    if (c.t - last < gap) continue;
    if (r.sfx.whoosh.includes(c.kind) && out.whoosh.length < 4) { out.whoosh.push(+c.t.toFixed(2)); last = c.t; } else if (r.sfx.pop.includes(c.kind) && out.pop.length < 6) { out.pop.push(+c.t.toFixed(2)); last = c.t; }
  }
  return out;
}
/** B-roll is wanted only when the recipe says so and (for noFaceOnly) no face is on screen. */
export const wantsBroll = (r: StyleRecipe, faceOnScreen: boolean): boolean => r.bRoll === 'topic' || (r.bRoll === 'noFaceOnly' && !faceOnScreen);
