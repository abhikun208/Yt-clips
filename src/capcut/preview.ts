import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { J } from './draft.ts';
import { subtitles, timelineEnd, findMaterial, isTextTrack } from './model.ts';

const assTime = (us: number): string => { const cs = Math.round(us / 10_000); const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60; return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
/** Subtitles as an ASS file (position/colour are approximations of the draft's text style, good enough for checking timing and wording). */
export function buildAss(j: J, W: number, H: number, range: { from: number; to: number }): string {
  const size = Math.round(H * 0.045);
  let out = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 14))},0,2,40,40,${Math.round(H * 0.08)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  for (const s of subtitles(j)) { if (s.end <= range.from || s.start >= range.to) continue; const y = s.ref.seg.clip?.transform?.y; const mv = typeof y === 'number' ? Math.round(H * (0.5 + y / 2) - size / 2) : Math.round(H * 0.08); const t = s.text.replace(/\n/g, '\\N').replace(/[{}]/g, ''); out += `Dialogue: 0,${assTime(Math.max(s.start, range.from) - range.from)},${assTime(Math.min(s.end, range.to) - range.from)},Default,,0,0,${Math.max(10, Math.min(H - size, mv))},,${t}\n`; }
  return out;
}

export interface PreviewOpts { out: string; height?: number; from?: number; to?: number; burnSubs?: boolean }
/** Low-quality draft render with ffmpeg only: every video/photo segment (speed, trim, scale, position), audio (volume, speed) and subtitles. Effects, filters, transitions and animations are NOT rendered. */
export function buildFfmpegArgs(j: J, o: PreviewOpts & { assPath?: string }): { args: string[]; notes: string[]; duration: number } {
  const cw = j.canvas_config?.width ?? 1080, ch = j.canvas_config?.height ?? 1920; const H = Math.round((o.height ?? 540) / 2) * 2; const W = Math.round((cw / ch) * H / 2) * 2; const from = o.from ?? 0, to = Math.min(o.to ?? Infinity, timelineEnd(j)); const dur = to - from; if (dur <= 0) throw new Error('nothing to render (empty range)');
  const notes: string[] = []; const inputs: string[] = []; const f: string[] = []; const fps = Math.min(30, j.fps || 30);
  f.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${(dur / 1e6).toFixed(3)}[base0]`); let cur = 'base0'; let vi = 0; const aOut: string[] = []; let ai = 0;
  const segs: { track: J; seg: J; ti: number }[] = []; j.tracks.forEach((t: J, ti: number) => { for (const s of t.segments) segs.push({ track: t, seg: s, ti }); });
  for (const { track, seg } of segs) {
    if (isTextTrack(track) || !seg.source_timerange) { if (!isTextTrack(track)) notes.push(`skipped a ${track.type} segment (not renderable offline)`); continue; }
    const t0 = seg.target_timerange.start, t1 = t0 + seg.target_timerange.duration; if (t1 <= from || t0 >= to) continue;
    const found = findMaterial(j, seg.material_id); const m = found?.mat; if (!m?.path || !existsSync(m.path)) { notes.push(`media missing: ${m?.path ?? seg.material_id}`); continue; }
    const sp = typeof seg.speed === 'number' && seg.speed > 0 ? seg.speed : 1; const a = Math.max(t0, from), b = Math.min(t1, to); const srcA = seg.source_timerange.start + (a - t0) * sp, srcB = seg.source_timerange.start + (b - t0) * sp;
    const idx = inputs.length; inputs.push(m.path);
    if (track.type === 'video' || track.type === 'image' || found?.kind === 'videos') {
      const isPhoto = m.type === 'photo'; const sc = seg.clip?.scale?.x ?? 1; const tx = seg.clip?.transform?.x ?? 0, ty = seg.clip?.transform?.y ?? 0; const vis = seg.visible !== false;
      if (vis) {
        const fitW = `min(${W}\\,${H}*iw/ih)`; const lab = `v${vi++}`;
        f.push(`[${idx}:v]${isPhoto ? '' : `trim=start=${(srcA / 1e6).toFixed(4)}:end=${(srcB / 1e6).toFixed(4)},`}setpts=${isPhoto ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${sp}`}+${((a - from) / 1e6).toFixed(4)}/TB,scale=w='trunc(${fitW}*${sc}/2)*2':h=-2,setsar=1[${lab}]`);
        const next = `base${vi}`; f.push(`[${cur}][${lab}]overlay=x='(W-w)/2+${tx}*W/2':y='(H-h)/2-(${ty})*H/2':eof_action=pass:enable='between(t,${((a - from) / 1e6).toFixed(4)},${((b - from) / 1e6).toFixed(4)})'[${next}]`); cur = next;
      }
      if (!isPhoto && m.has_audio !== false && (seg.volume ?? 1) > 0) { const lab = `a${ai++}`; f.push(`[${idx}:a]atrim=start=${(srcA / 1e6).toFixed(4)}:end=${(srcB / 1e6).toFixed(4)},asetpts=PTS-STARTPTS,${tempo(sp)}volume=${seg.volume ?? 1},adelay=${Math.round((a - from) / 1000)}:all=1[${lab}]`); aOut.push(lab); }
    } else if (track.type === 'audio') { const lab = `a${ai++}`; f.push(`[${idx}:a]atrim=start=${(srcA / 1e6).toFixed(4)}:end=${(srcB / 1e6).toFixed(4)},asetpts=PTS-STARTPTS,${tempo(sp)}volume=${seg.volume ?? 1},adelay=${Math.round((a - from) / 1000)}:all=1[${lab}]`); aOut.push(lab); }
  }
  let vlab = cur; if (o.burnSubs !== false && o.assPath && subtitles(j).length) { f.push(`[${cur}]subtitles='${o.assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'[vout]`); vlab = 'vout'; }
  const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputs.flatMap((p) => ['-i', p])]; let g = f.join(';');
  if (aOut.length) { g += `;${aOut.map((l) => `[${l}]`).join('')}amix=inputs=${aOut.length}:normalize=0:duration=longest,atrim=0:${(dur / 1e6).toFixed(3)}[aout]`; }
  args.push('-filter_complex', g, '-map', `[${vlab}]`, ...(aOut.length ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-t', (dur / 1e6).toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', o.out);
  return { args, notes, duration: dur };
}
const tempo = (sp: number): string => { if (Math.abs(sp - 1) < 1e-6) return ''; const parts: string[] = []; let x = sp; while (x > 2) { parts.push('atempo=2'); x /= 2; } while (x < 0.5) { parts.push('atempo=0.5'); x /= 0.5; } parts.push(`atempo=${x.toFixed(5)}`); return parts.join(',') + ','; };

export function renderPreview(j: J, o: PreviewOpts): { out: string; notes: string[]; seconds: number } {
  const tmp = mkdtempSync(join(tmpdir(), 'capcut-prev-')); try {
    const H = o.height ?? 540; const cw = j.canvas_config?.width ?? 1080, ch = j.canvas_config?.height ?? 1920; const W = Math.round((cw / ch) * H / 2) * 2; const ass = join(tmp, 'subs.ass'); writeFileSync(ass, buildAss(j, W, H, { from: o.from ?? 0, to: Math.min(o.to ?? Infinity, timelineEnd(j)) }));
    const { args, notes, duration } = buildFfmpegArgs(j, { ...o, assPath: ass }); const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 3600_000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) { if (/No such filter: 'subtitles'/.test(r.stderr ?? '')) throw new Error('this ffmpeg has no subtitles filter (libass): run with --no-subs'); throw new Error('ffmpeg failed: ' + (r.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)); }
    return { out: o.out, notes: [...new Set(notes)], seconds: duration / 1e6 };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
