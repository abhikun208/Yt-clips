import { zoomExpr } from './beats.ts';
import { addVfx, type VfxOpts } from './vfx.ts';
// Pure filtergraph builders (unit-testable). Every treatment is recorded so the manifest is truthful.
export type Mood = 'funny' | 'sad' | 'happy' | 'shock' | 'aggressive' | 'cute' | 'high_energy' | 'dynamic_visuals' | 'dialogue' | 'general' | string;

export interface Treatment { dimension: string; applied: boolean; detail: string }

/** The full set of editing dimensions this engine can apply. Coverage = applied / total (honest, measured from the manifest). */
export const DIMENSIONS = ['reframe_9x16', 'color_grade', 'contrast_exposure', 'vignette', 'dynamic_zoom', 'glow', 'sharpen', 'captions', 'title_animation', 'fade_transition', 'voice_enhance', 'loudness_norm', 'noise_reduction', 'music_ducking', 'speed_ramp', 'beat_effects', 'cinematic_lut', 'film_grain', 'particles', 'light_leak', 'flash_transition', 'progress_bar', 'jump_cuts', 'emphasis_zoom'] as const;

export function gradeFor(mood: Mood): { eq: string; balance: string; detail: string } {
  switch (mood) {
    case 'sad': return { eq: 'eq=contrast=1.08:saturation=0.8:brightness=-0.02', balance: 'colorbalance=bs=0.06:rs=-0.04', detail: 'cool desaturated' };
    case 'aggressive': return { eq: 'eq=contrast=1.2:saturation=1.1:brightness=-0.03', balance: 'colorbalance=rs=0.08:bs=-0.05', detail: 'high-contrast warm-red' };
    case 'funny': case 'happy': case 'cute': return { eq: 'eq=contrast=1.06:saturation=1.25:brightness=0.03', balance: 'colorbalance=rs=0.03:gs=0.01', detail: 'bright warm saturated' };
    case 'shock': case 'high_energy': return { eq: 'eq=contrast=1.15:saturation=1.2', balance: 'colorbalance=bs=0.03', detail: 'punchy contrast' };
    default: return { eq: 'eq=contrast=1.08:saturation=1.1', balance: 'colorbalance=rs=0.02:bs=-0.02', detail: 'neutral cinematic' };
  }
}

/** Screen-blend two video labels in RGB (gbrp). Blending in yuv420p also blends the chroma planes, which shifts every colour toward magenta (the pink tint bug). */
export function screenBlend(parts: string[], a: string, b: string, out: string, opacity: number): void {
  parts.push(`[${a}]format=gbrp[${a}_g];[${b}]format=gbrp[${b}_g];[${a}_g][${b}_g]blend=all_mode=screen:all_opacity=${opacity}:shortest=1[${out}]`);
}
export interface VideoGraphOpts {
  inW: number; inH: number; outW: number; outH: number; fps: number; duration: number; mood: Mood;
  reframe: 'crop' | 'fit_blur' | 'gamer_stack' | 'split_gameplay'; fillIdx?: number; facecam?: { x: number; y: number; w: number; h: number }; cropXFrac?: number; cropTrack?: [number, number][]; // 0..1 center of subject horizontally (from face tracking), default .5
  deinterlace?: boolean; assPath?: string; fontsDir?: string; zoom: boolean; glow: boolean; fade: boolean; punch?: number[];
  vfx?: Omit<VfxOpts, 'w' | 'h' | 'fps' | 'duration' | 'mood'>;
}

/** Escape a path for use inside an ffmpeg filter argument. */
export const escFilterPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');

/** Reframe to 9:16 producing label [base]. Exported so the change-measurement baseline uses the identical crop. */
export function reframeParts(o: Pick<VideoGraphOpts, 'inW' | 'inH' | 'outW' | 'outH' | 'reframe' | 'cropXFrac' | 'cropTrack' | 'facecam' | 'fillIdx'>, inLabel = '0:v'): { parts: string[]; treatments: Treatment[] } {
  const parts: string[] = []; const t: Treatment[] = [];
  const aspectIn = o.inW / o.inH; const aspectOut = o.outW / o.outH;
  const alreadyVertical = Math.abs(aspectIn - aspectOut) < 0.02;

  if (o.reframe === 'split_gameplay' && o.fillIdx !== undefined) {
    // split screen: the clip on top, the owner's own looping gameplay/satisfying footage (muted) on the bottom — a retention layout
    const topH = Math.round(o.outH * 0.56 / 2) * 2, botH = o.outH - topH;
    parts.push(`[${inLabel}]scale=${o.outW}:${topH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${o.outW}:${topH}[gtop];[${o.fillIdx}:v]scale=${o.outW}:${botH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${o.outW}:${botH},setsar=1[fbot];[gtop][fbot]vstack=inputs=2,setsar=1[base]`);
    t.push({ dimension: 'reframe_9x16', applied: true, detail: `split screen: clip top ${topH}px + gameplay filler bottom ${botH}px` });
  } else if (alreadyVertical) {
    parts.push(`[${inLabel}]scale=${o.outW}:${o.outH}:flags=lanczos,setsar=1[base]`);
    t.push({ dimension: 'reframe_9x16', applied: false, detail: 'source already 9:16' });
  } else if (o.reframe === 'gamer_stack' && o.facecam) {
    // gameplay on top (centre-cropped to fill 60% of the height), streamer's facecam rectangle on the bottom 40%
    const topH = Math.round(o.outH * 0.6 / 2) * 2, botH = o.outH - topH, f = o.facecam;
    parts.push(`[${inLabel}]split=2[gp][fc];[gp]scale=${o.outW}:${topH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${o.outW}:${topH}[gtop];`
      + `[fc]crop=w='trunc(iw*${f.w.toFixed(4)}/2)*2':h='trunc(ih*${f.h.toFixed(4)}/2)*2':x='trunc(iw*${f.x.toFixed(4)}/2)*2':y='trunc(ih*${f.y.toFixed(4)}/2)*2',scale=${o.outW}:${botH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${o.outW}:${botH}[fbot];`
      + `[gtop][fbot]vstack=inputs=2,setsar=1[base]`);
    t.push({ dimension: 'reframe_9x16', applied: true, detail: `gamer stack: gameplay top ${topH}px + facecam bottom ${botH}px` });
  } else if (o.reframe === 'fit_blur') {
    parts.push(`[${inLabel}]split=2[bg][fg];[bg]scale=${o.outW}:${o.outH}:force_original_aspect_ratio=increase,crop=${o.outW}:${o.outH},boxblur=24:3,eq=brightness=-0.08[bgb];[fg]scale=${o.outW}:-2:flags=lanczos[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`);
    t.push({ dimension: 'reframe_9x16', applied: true, detail: 'fit with blurred background (no subject cropped)' });
  } else {
    // Crop to 9:16 window around subject centre, then scale. Window width = inH*9/16.
    const cx = Math.min(0.95, Math.max(0.05, o.cropXFrac ?? 0.5));
    const cw = `trunc(ih*${o.outW}/${o.outH}/2)*2`;
    const xe = o.cropTrack && o.cropTrack.length >= 3 ? `(${trackExpr(o.cropTrack.map(([t, v]) => [t, Math.min(0.95, Math.max(0.05, v))] as [number, number]))})` : cx.toFixed(3);
    parts.push(`[${inLabel}]crop=w=${cw}:h=ih:x='max(0,min(iw-ow,iw*${xe}-ow/2))':y=0,scale=${o.outW}:${o.outH}:flags=lanczos,setsar=1[base]`);
    t.push({ dimension: 'reframe_9x16', applied: true, detail: o.cropTrack && o.cropTrack.length >= 3 ? `speaker-follow crop (${o.cropTrack.length} keyframes, active speaker by mouth motion)` : `center-crop around x=${cx.toFixed(2)}${o.cropXFrac === undefined ? ' (no face tracking: centered)' : ' (face-tracked)'}` });
  }

  return { parts, treatments: t };
}

export function buildVideoGraph(o: VideoGraphOpts): { graph: string; treatments: Treatment[] } {
  const t: Treatment[] = [];
  const g = gradeFor(o.mood);
  const parts: string[] = [];
  let inLab = '0:v'; if (o.deinterlace) { parts.push(`[0:v]yadif=mode=0:parity=-1:deint=0[dv]`); inLab = 'dv'; t.push({ dimension: 'deinterlace', applied: true, detail: 'interlaced source (TV footage): yadif removes the horizontal comb lines' }); }
  const rf = reframeParts(o, inLab); parts.push(...rf.parts); t.push(...rf.treatments);

  let cur = 'base'; let n = 0;
  const chain = (f: string) => { const nx = `v${n++}`; parts.push(`[${cur}]${f}[${nx}]`); cur = nx; };

  const punch = o.punch ?? [];
  if (o.zoom || punch.length) {
    const frames = Math.max(1, Math.round(o.duration * o.fps));
    chain(`fps=${o.fps},zoompan=z='${zoomExpr(frames, o.fps, o.zoom, punch)}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${o.outW}x${o.outH}:fps=${o.fps}`);
    t.push({ dimension: 'dynamic_zoom', applied: o.zoom, detail: o.zoom ? 'slow push-in to 112%' : 'disabled' });
  } else t.push({ dimension: 'dynamic_zoom', applied: false, detail: 'disabled' });
  t.push(punch.length ? { dimension: 'beat_effects', applied: true, detail: `punch-zoom (+6%, 0.4s) at audio peaks: ${punch.map((x) => x.toFixed(1) + 's').join(', ')}` } : { dimension: 'beat_effects', applied: false, detail: 'no strong audio peaks found (or disabled)' });

  chain(g.eq); chain(g.balance);
  t.push({ dimension: 'color_grade', applied: true, detail: `${o.mood}: ${g.detail}` });
  t.push({ dimension: 'contrast_exposure', applied: true, detail: 'eq contrast/saturation/brightness per mood' });
  chain('unsharp=5:5:0.6:5:5:0.0'); t.push({ dimension: 'sharpen', applied: true, detail: 'mild luma unsharp' });
  chain('vignette=PI/5'); t.push({ dimension: 'vignette', applied: true, detail: 'soft vignette' });

  if (o.glow) {
    const a = `v${n++}`; const b = `v${n++}`; const c = `v${n++}`;
    parts.push(`[${cur}]split=2[${a}][${b}]`);
    parts.push(`[${b}]gblur=sigma=18,eq=brightness=-0.15[${c}]`);
    const out = `v${n++}`;
    screenBlend(parts, a, c, out, 0.28);
    cur = out; t.push({ dimension: 'glow', applied: true, detail: 'soft bloom (screen blend, 28%)' });
  } else t.push({ dimension: 'glow', applied: false, detail: 'disabled' });

  if (o.vfx) {
    t.push(...addVfx({ ...o.vfx, w: o.outW, h: o.outH, fps: o.fps, duration: o.duration, mood: o.mood }, parts, chain, () => cur, (l) => { cur = l; }, () => n++));
  } else for (const d of ['cinematic_lut', 'film_grain', 'particles', 'light_leak', 'flash_transition', 'progress_bar']) t.push({ dimension: d, applied: false, detail: 'disabled' });

  if (o.fade) {
    chain(`fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, o.duration - 0.3).toFixed(2)}:d=0.3`);
    t.push({ dimension: 'fade_transition', applied: true, detail: 'in/out fade' });
  } else t.push({ dimension: 'fade_transition', applied: false, detail: 'disabled' });

  if (o.assPath) {
    chain(`subtitles='${escFilterPath(o.assPath)}'${o.fontsDir ? `:fontsdir='${escFilterPath(o.fontsDir)}'` : ''}`);
    t.push({ dimension: 'captions', applied: true, detail: 'ASS animated captions (approx. word timing)' });
    t.push({ dimension: 'title_animation', applied: true, detail: 'pop-in title overlay' });
  } else {
    t.push({ dimension: 'captions', applied: false, detail: 'no transcript available (nothing fabricated)' });
    t.push({ dimension: 'title_animation', applied: false, detail: 'no title overlay' });
  }
  chain('format=yuv420p');
  return { graph: parts.join(';') + `;[${cur}]null[vout]`, treatments: t };
}

export interface AudioGraphOpts { hasAudio: boolean; targetLufs: number; music?: boolean; duration: number }

export function buildAudioGraph(o: AudioGraphOpts): { graph: string | null; treatments: Treatment[] } {
  const t: Treatment[] = [];
  if (!o.hasAudio) {
    for (const d of ['voice_enhance', 'loudness_norm', 'noise_reduction', 'music_ducking']) t.push({ dimension: d, applied: false, detail: 'source has no audio' });
    return { graph: null, treatments: t };
  }
  const voice = `[0:a]highpass=f=80,afftdn=nr=12:nf=-40,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,equalizer=f=3000:t=q:w=1.2:g=2`;
  t.push({ dimension: 'voice_enhance', applied: true, detail: 'highpass + compressor + presence EQ' });
  t.push({ dimension: 'noise_reduction', applied: true, detail: 'afftdn nr=12dB' });
  const fade = `afade=t=in:st=0:d=0.1,afade=t=out:st=${Math.max(0, o.duration - 0.3).toFixed(2)}:d=0.3`;
  let g: string;
  if (o.music) {
    g = `${voice},asplit=2[vo][sc];[1:a]volume=0.18,aloop=loop=-1:size=2e9,atrim=0:${o.duration.toFixed(2)}[m];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[md];[vo][md]amix=inputs=2:duration=first:normalize=0,loudnorm=I=${o.targetLufs}:TP=-1.5:LRA=11,${fade}[aout]`;
    t.push({ dimension: 'music_ducking', applied: true, detail: 'authorized BGM ducked under voice (sidechain)' });
  } else {
    g = `${voice},loudnorm=I=${o.targetLufs}:TP=-1.5:LRA=11,${fade}[aout]`;
    t.push({ dimension: 'music_ducking', applied: false, detail: 'no authorized music file in assets/music' });
  }
  t.push({ dimension: 'loudness_norm', applied: true, detail: `loudnorm I=${o.targetLufs} LUFS TP=-1.5` });
  return { graph: g, treatments: t };
}

/** Coverage across ALL known dimensions incl. unimplemented ones (speed_ramp, beat_effects count as not applied). */
export function treatmentCoverage(all: Treatment[]): { applied: number; total: number; coverage: number; notApplied: string[] } {
  const by = new Map(all.map((x) => [x.dimension, x.applied]));
  let applied = 0; const notApplied: string[] = [];
  for (const d of DIMENSIONS) { if (by.get(d)) applied++; else notApplied.push(d); }
  return { applied, total: DIMENSIONS.length, coverage: +(applied / DIMENSIONS.length).toFixed(3), notApplied };
}

/** ffmpeg expression for a piecewise-linear value over time t from [[t,v],...] keyframes (held flat before/after). Used for the speaker-follow crop. */
export function trackExpr(track: [number, number][], key = 't'): string {
  const pts = track.length > 40 ? track.filter((_, i) => i % Math.ceil(track.length / 40) === 0 || i === track.length - 1) : track;
  let e = pts[pts.length - 1]![1].toFixed(3);
  for (let i = pts.length - 2; i >= 0; i--) { const [t0, v0] = pts[i]!, [t1, v1] = pts[i + 1]!; const dt = Math.max(0.05, t1 - t0); e = `if(lt(${key},${t1.toFixed(2)}),${v0.toFixed(3)}+(${(v1 - v0).toFixed(4)})*(${key}-${t0.toFixed(2)})/${dt.toFixed(2)},${e})`; }
  return `if(lt(${key},${pts[0]![0].toFixed(2)}),${pts[0]![1].toFixed(3)},${e})`;
}
