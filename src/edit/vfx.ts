// Extra visual treatments built with plain ffmpeg filters (no overlay assets, no paid tools): cinematic curves / owner .cube LUT,
// film grain, drifting dust particles, animated light leak, flash transitions on beats. Pure builders; every one is recorded as a Treatment.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Treatment } from './filters.ts';

export interface VfxOpts {
  w: number; h: number; fps: number; duration: number; mood: string;
  lut: boolean; grain: boolean; particles: boolean; lightLeak: boolean; flash: boolean;
  flashAt: number[]; lutFile?: string; progress?: boolean;
}
export const VFX_DEFAULTS = { lut: true, grain: true, particles: true, lightLeak: true, flash: true, progress: true };

const q = (s: string) => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** Cinematic tone curve per mood (a "LUT" made of curves). Dark red/black for aggressive, bright for comedy, teal-orange default. */
export function curveFor(mood: string): { f: string; detail: string } {
  switch (mood) {
    case 'aggressive': return { f: `curves=r='0/0 0.45/0.5 1/1':g='0/0 0.5/0.42 1/0.9':b='0/0 0.5/0.4 1/0.85'`, detail: 'dark red/black cinematic curve' };
    case 'funny': case 'happy': case 'cute': return { f: `curves=all='0/0 0.35/0.42 0.75/0.82 1/1'`, detail: 'bright lifted-shadows curve' };
    case 'sad': return { f: `curves=r='0/0 1/0.93':b='0/0.04 0.5/0.55 1/1'`, detail: 'cool blue-shadow curve' };
    default: return { f: `curves=r='0/0.02 0.5/0.52 1/1':b='0/0.06 0.5/0.48 1/0.92'`, detail: 'teal-orange cinematic curve' };
  }
}

/** First owner-supplied .cube LUT in assets/luts (nothing is bundled). */
export function findLut(assetsDir: string): string | undefined {
  const d = join(assetsDir, 'luts');
  if (!existsSync(d)) return undefined;
  const f = readdirSync(d).filter((x) => /\.cube$/i.test(x)).sort()[0];
  return f ? join(d, f) : undefined;
}

function leakColor(mood: string): [number, number, number, string] {
  if (mood === 'aggressive') return [255, 70, 40, 'red'];
  if (mood === 'sad') return [70, 130, 255, 'blue'];
  if (mood === 'shock' || mood === 'high_energy') return [255, 200, 90, 'gold'];
  return [255, 150, 60, 'warm orange'];
}

/**
 * Append the VFX chain to `cur`. `chain(f)` adds a simple filter; `parts` receives multi-input pieces. Returns the new current label.
 * Sources are generated inside the graph (color/geq at low resolution then scaled up), so nothing to download or license.
 */
export function addVfx(o: VfxOpts, parts: string[], chain: (f: string) => void, getCur: () => string, setCur: (l: string) => void, next: () => number): Treatment[] {
  const t: Treatment[] = [];
  if (o.lut) {
    if (o.lutFile) { chain(`lut3d=file='${q(o.lutFile)}'`); t.push({ dimension: 'cinematic_lut', applied: true, detail: `owner LUT ${o.lutFile.split('/').pop()}` }); }
    else { const c = curveFor(o.mood); chain(c.f); t.push({ dimension: 'cinematic_lut', applied: true, detail: c.detail }); }
  } else t.push({ dimension: 'cinematic_lut', applied: false, detail: 'disabled' });

  if (o.grain) { chain('noise=alls=6:allf=t'); t.push({ dimension: 'film_grain', applied: true, detail: 'temporal film grain (alls=6)' }); }
  else t.push({ dimension: 'film_grain', applied: false, detail: 'disabled' });

  const times = o.flashAt.filter((x) => x > 0.3 && x < o.duration - 0.3).slice(0, 3);
  if (o.flash && times.length) {
    const e = times.map((x) => `0.2*max(0,1-abs(t-${x.toFixed(2)})/0.12)`).join('+');
    chain(`eq=brightness='${e}':eval=frame`);
    t.push({ dimension: 'flash_transition', applied: true, detail: `0.24s brightness flash at ${times.map((x) => x.toFixed(1) + 's').join(', ')}` });
  } else t.push({ dimension: 'flash_transition', applied: false, detail: o.flash ? 'no beat/ramp moments to flash on' : 'disabled' });

  const d = (o.duration + 1).toFixed(2);
  if (o.particles) {
    const pw = Math.round(o.w / 4), ph = Math.round(o.h / 4);
    const src = `p${next()}`; const out = `v${next()}`;
    parts.push(`color=c=black:s=${pw}x${ph}:r=${o.fps}:d=${d},format=gray,noise=alls=100:allf=u:all_seed=11,lut=y='if(gt(val\\,92)\\,255\\,0)',scroll=v=-0.0035,scale=${o.w}:${o.h}:flags=bicubic,gblur=sigma=3.2,format=rgb24,colorchannelmixer=gg=0.88:bb=0.6,format=yuv420p[${src}]`);
    parts.push(`[${getCur()}][${src}]blend=all_mode=screen:all_opacity=0.55:shortest=1[${out}]`);
    setCur(out); t.push({ dimension: 'particles', applied: true, detail: 'drifting dust/bokeh specks (generated, screen blend 55%)' });
  } else t.push({ dimension: 'particles', applied: false, detail: 'disabled' });

  if (o.lightLeak) {
    const [r, g, b, name] = leakColor(o.mood); const per = Math.max(3, Math.min(8, o.duration / 2)).toFixed(2);
    const src = `l${next()}`; const out = `v${next()}`;
    const k = `exp(-(pow(X/W-(0.1+0.8*mod(T/${per}\\,1))\\,2)*8+pow(Y/H-0.25\\,2)*4))*(0.3+0.3*sin(2*PI*T/${per}))`;
    parts.push(`color=c=black:s=108x192:r=${o.fps}:d=${d},format=rgb24,geq=r='${r}*${k}':g='${g}*${k}':b='${b}*${k}',scale=${o.w}:${o.h}:flags=bicubic,format=yuv420p[${src}]`);
    parts.push(`[${getCur()}][${src}]blend=all_mode=screen:all_opacity=0.6:shortest=1[${out}]`);
    setCur(out); t.push({ dimension: 'light_leak', applied: true, detail: `${name} light leak sweeping across, pulsing every ~${per}s` });
  } else t.push({ dimension: 'light_leak', applied: false, detail: 'disabled' });

  if (o.progress) {
    const bar = `b${next()}`; const out = `v${next()}`; const bh = Math.max(6, Math.round(o.h / 190));
    parts.push(`color=c=white:s=${o.w}x${bh}:r=${o.fps}:d=${d},format=yuv420p[${bar}]`);
    parts.push(`[${getCur()}][${bar}]overlay=x='-w+w*t/${o.duration.toFixed(2)}':y=${Math.round(o.h * 0.915)}:shortest=1[${out}]`);
    setCur(out); t.push({ dimension: 'progress_bar', applied: true, detail: 'animated progress bar (retention cue)' });
  } else t.push({ dimension: 'progress_bar', applied: false, detail: 'disabled' });
  return t;
}
