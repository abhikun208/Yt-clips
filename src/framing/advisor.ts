/**
 * Framing advisor (opt-in; NOT called by src/edit/render.ts until the owner approves the hook). Turns all-faces samples + protected gaming
 * regions into ONE clip-level decision between the two reframe modes that already exist: 'crop' (with a safer centre) or 'fit_blur'.
 * Returns undefined whenever it has nothing reliable to say (no detector/OpenCV, timeout, too few face samples, bad JSON, exception):
 * the caller must then behave exactly as before. It never throws.
 */
import { join } from 'node:path';
import { run, which } from '../util/proc.ts';
import { planLayout, safeCrop, type Sample, type Rect, type LayoutKind } from './plan.ts';

export interface FramingAdvice { reframe: 'crop' | 'fit_blur' | 'multi_stack'; /** multi_stack: horizontal centre (0..1) of each of the 2-3 people */ tiles?: { cx: number }[]; /** 0..1 horizontal centre for the crop (only with reframe 'crop') */ cropX?: number; layout: LayoutKind | 'gaming'; note: string }
export type Sampler = (src: string, rootDir: string) => Promise<Sample[] | null>;
export interface AdvisorInput { src: string; rootDir: string; duration: number; gaming?: boolean; protect?: Rect[]; /** source width/height (default 16:9) */ aspect?: number; sampler?: Sampler }

/** ASSUMED typical shooter/battle-royale layout (fractions of the frame); not detected from pixels. */
export const DEFAULT_GAMING_ZONES: Rect[] = [
  { x: 0, y: 0, w: 0.2, h: 0.3 },      // minimap (top-left)
  { x: 0.8, y: 0, w: 0.2, h: 0.3 },    // kill feed / team list (top-right)
  { x: 0, y: 0.8, w: 0.22, h: 0.2 },   // health / armour (bottom-left)
  { x: 0.78, y: 0.8, w: 0.22, h: 0.2 } // ammo / weapons (bottom-right)
];
const MIN_FACE_SAMPLES = 8; const FACE_MARGIN = 0.1; // half a typical face width (fraction of frame)

/** Default sampler: tools/face_samples.py via python3. null = unavailable/failed. */
export const pythonSampler: Sampler = async (src, rootDir) => {
  try {
    if (!(await which('python3'))) return null;
    const r = await run('python3', ['-I', join(rootDir, 'tools', 'face_samples.py'), src, '4'], { timeoutMs: 4 * 60_000 });
    const j = JSON.parse(r.stdout.trim() || '{}') as { samples?: Sample[]; error?: string };
    return Array.isArray(j.samples) && !j.error ? j.samples : null;
  } catch { return null; }
};

export function decide(samples: Sample[], o: { duration: number; gaming?: boolean; protect?: Rect[]; aspect?: number }): FramingAdvice | undefined {
  const aspect = o.aspect && o.aspect > 0 ? o.aspect : 16 / 9; const protect = o.gaming ? (o.protect ?? DEFAULT_GAMING_ZONES) : [];
  const withFaces = samples.filter((s) => s.faces.length).length;
  const spans = planLayout(samples, { maxTiles: 4 }); if (!spans.length) return undefined;
  const dur = (l: (k: LayoutKind) => boolean) => spans.filter((s) => l(s.layout)).reduce((a, s) => a + (s.end - s.start), 0);
  const total = spans.reduce((a, s) => a + (s.end - s.start), 0) || 1; const faceTime = dur((k) => k !== 'fit');
  const gamingCrop = (prefer: number, why: string): FramingAdvice => { const c = safeCrop(protect, prefer, { frameAspect: aspect }); return c.ok ? { reframe: 'crop', cropX: +(c.x + c.w / 2).toFixed(3), layout: 'gaming', note: `framing advisor: ${why}; protected regions kept whole` } : { reframe: 'fit_blur', layout: 'gaming', note: `framing advisor: ${why}; ${c.note}` }; };
  // no usable faces: only gaming has a decision to make (protect HUD/minimap/kill feed); otherwise leave the existing logic alone
  if (withFaces < MIN_FACE_SAMPLES || faceTime / total < 0.5) return o.gaming && protect.length ? gamingCrop(0.5, 'gaming, no stable face') : undefined;
  const faceKinds = (['single', 'split', 'trio', 'grid'] as LayoutKind[]).filter((k) => dur((x) => x === k) / total >= 0.2);
  if (faceKinds.length > 1) return { reframe: 'fit_blur', layout: 'grid', note: `framing advisor: layout changes during the clip (${faceKinds.join('/')}): fit + blur keeps everyone in view` };
  const xs = spans.filter((s) => s.layout !== 'fit').flatMap((s) => s.focus); const lo = Math.min(...xs) - FACE_MARGIN, hi = Math.max(...xs) + FACE_MARGIN;
  const kind = faceKinds[0] ?? 'single'; const win = (9 / 16) / aspect;
  if (kind === 'single') return o.gaming && protect.length ? (() => { const a = gamingCrop((lo + hi) / 2, 'one face'); return a.reframe === 'fit_blur' ? a : undefined; })() : undefined; // existing speaker-follow handles one face
  if (hi - lo > win && (kind === 'split' || kind === 'trio')) { // 2-3 people too far apart for one 9:16 window: one tile per person instead of cutting someone or shrinking everything
    const best = spans.filter((x) => x.layout === kind).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]; const cxs = (best?.focus ?? []).slice().sort((a, b) => a - b);
    if (cxs.length >= 2 && cxs.length <= 3) return { reframe: 'multi_stack', tiles: cxs.map((cx) => ({ cx: +cx.toFixed(3) })), layout: kind, note: `framing advisor: ${kind} people are ${Math.round((hi - lo) * 100)}% of the frame wide (> 9:16 window ${Math.round(win * 100)}%): multi-person stack, one tile per person` };
  }
  if (hi - lo > win) return { reframe: 'fit_blur', layout: kind, note: `framing advisor: ${kind} people are ${Math.round((hi - lo) * 100)}% of the frame wide (> 9:16 window ${Math.round(win * 100)}%): fit + blur instead of cutting someone` };
  const mid = (lo + hi) / 2; if (!o.gaming || !protect.length) return { reframe: 'crop', cropX: +mid.toFixed(3), layout: kind, note: `framing advisor: ${kind} people fit one 9:16 window: crop centred between them` };
  const a = gamingCrop(mid, `${kind} people`); if (a.reframe !== 'crop') return a;
  const wx = a.cropX ?? mid; if (wx - win / 2 > lo + 1e-6 || wx + win / 2 < hi - 1e-6) return { reframe: 'fit_blur', layout: kind, note: `framing advisor: keeping the HUD/minimap whole would cut a person (${kind}): fit + blur` };
  return { ...a, layout: kind };
}

export async function adviseFraming(i: AdvisorInput): Promise<FramingAdvice | undefined> {
  try {
    const samples = await (i.sampler ?? pythonSampler)(i.src, i.rootDir); if (!samples || !samples.length) return undefined;
    return decide(samples, { duration: i.duration, ...(i.gaming !== undefined ? { gaming: i.gaming } : {}), ...(i.protect ? { protect: i.protect } : {}), ...(i.aspect !== undefined ? { aspect: i.aspect } : {}) });
  } catch { return undefined; }
}
