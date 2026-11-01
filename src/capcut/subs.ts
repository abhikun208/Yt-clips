import type { J } from './draft.ts';
import { uuid, materialsOf, recomputeDuration, sortTrack, setText, getText, subtitles, defaultStyleRun, isTextTrack, type Sub } from './model.ts';
import { fmtCue } from './time.ts';

export interface Cue { start: number; end: number; text: string }

/* ---------------- parsing / formatting ---------------- */
const TS = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const tsToUs = (m: RegExpExecArray): number => Math.round(((Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) + Number(m[4]!.padEnd(3, '0')) / 1000) * 1e6);
/** Reads SRT and WebVTT (BOM, CRLF, missing numbers, cue settings, NOTE/STYLE blocks are all tolerated). */
export function parseCues(text: string): Cue[] {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/); const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.replace(/\s+$/, '')); if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]!.trim())) continue;
    const ti = lines.findIndex((l) => l.includes('-->')); if (ti < 0) continue;
    const [a, rest] = lines[ti]!.split('-->'); const ma = TS.exec(a!.trim()), mb = TS.exec((rest ?? '').trim()); if (!ma || !mb) continue;
    const body = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); if (!body) continue;
    const start = tsToUs(ma), end = tsToUs(mb); if (end > start) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}
export const toSrt = (cues: Cue[]): string => cues.map((c, i) => `${i + 1}\n${fmtCue(c.start, ',')} --> ${fmtCue(c.end, ',')}\n${c.text}\n`).join('\n');
export const toVtt = (cues: Cue[]): string => 'WEBVTT\n\n' + cues.map((c) => `${fmtCue(c.start, '.')} --> ${fmtCue(c.end, '.')}\n${c.text}\n`).join('\n');
export const exportCues = (j: J): Cue[] => subtitles(j).map((s) => ({ start: s.start, end: s.end, text: s.text }));

/* ---------------- writing into a draft ---------------- */
const defaultTextMaterial = (text: string): J => ({ id: uuid(), type: 'text', content: JSON.stringify({ text, styles: [defaultStyleRun([...text].length)] }), font_size: 8.0, text_color: '#FFFFFF', alignment: 1, line_spacing: 0.02, letter_spacing: 0.0, typesetting: 0, add_type: 0, check_flag: 7, global_alpha: 1.0, base_content: '', words: { start_time: [], end_time: [], text: [] } });
const defaultTextSegment = (materialId: string, start: number, dur: number): J => ({ id: uuid(), material_id: materialId, target_timerange: { start, duration: dur }, source_timerange: null, render_index: 14000, track_render_index: 0, visible: true, volume: 1.0, speed: 1.0, clip: { alpha: 1.0, flip: { horizontal: false, vertical: false }, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: -0.8 } }, uniform_scale: { on: true, value: 1.0 }, extra_material_refs: [], common_keyframes: [], keyframe_refs: [], enable_adjust: true });
const textTrack = (name: string): J => ({ id: uuid(), type: 'text', name, segments: [], attribute: 0, flag: 0, is_default_name: false });

/** Adds cues as text segments. New segments copy the look (material + position) of an existing subtitle when the draft has one. */
export function addCues(j: J, cues: Cue[], o: { track?: number; offset?: number; replace?: boolean; styleFrom?: Sub } = {}): { added: number; track: number } {
  let ti = o.track !== undefined ? o.track - 1 : j.tracks.findIndex((t: J) => isTextTrack(t) && t.name === 'subtitles'); if (ti < 0) ti = j.tracks.findIndex((t: J) => isTextTrack(t));
  if (ti >= 0 && !isTextTrack(j.tracks[ti])) throw new Error(`track ${ti + 1} is a ${j.tracks[ti].type} track, not a text track`);
  if (ti < 0) { j.tracks.push(textTrack('subtitles')); ti = j.tracks.length - 1; }
  const track = j.tracks[ti]; const ref = o.styleFrom ?? subtitles(j)[0];
  if (o.replace) { const drop = new Set(track.segments.map((s: J) => s.material_id)); track.segments = []; j.materials.texts = materialsOf(j, 'texts').filter((m: J) => !drop.has(m.id)); }
  for (const c of cues) {
    const start = Math.max(0, c.start + (o.offset ?? 0)); const dur = c.end - c.start; let mat: J, seg: J;
    if (ref) { const m0 = materialsOf(j, 'texts').find((m: J) => m.id === ref.ref.seg.material_id); mat = JSON.parse(JSON.stringify(m0 ?? defaultTextMaterial(''))); mat.id = uuid(); seg = JSON.parse(JSON.stringify(ref.ref.seg)); seg.id = uuid(); seg.material_id = mat.id; seg.extra_material_refs = []; seg.common_keyframes = []; seg.keyframe_refs = []; }
    else { mat = defaultTextMaterial(c.text); seg = defaultTextSegment(mat.id, start, dur); }
    setText(mat, c.text); seg.target_timerange = { start, duration: dur }; seg.source_timerange = null; materialsOf(j, 'texts').push(mat); track.segments.push(seg);
  }
  sortTrack(track); recomputeDuration(j); return { added: cues.length, track: ti + 1 };
}

/* ---------------- editing existing subtitles ---------------- */
export function pick(j: J, n: number): Sub { const s = subtitles(j)[n - 1]; if (!s) throw new Error(`subtitle ${n} does not exist (there are ${subtitles(j).length})`); return s; }
export function editText(j: J, n: number, text: string): void { const s = pick(j, n); const f = (j.materials.texts as J[]).find((m) => m.id === s.ref.seg.material_id)!; setText(f, text); }
export function replaceText(j: J, find: string, repl: string, o: { regex?: boolean; ignoreCase?: boolean } = {}): number {
  const re = o.regex ? new RegExp(find, 'g' + (o.ignoreCase ? 'i' : '')) : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (o.ignoreCase ? 'i' : '')); let n = 0;
  for (const s of subtitles(j)) { const f = (j.materials.texts as J[]).find((m) => m.id === s.ref.seg.material_id)!; const t = getText(f); const t2 = t.replace(re, repl); if (t2 !== t) { setText(f, t2); n++; } } return n;
}
/** Re-time subtitles: shift by an offset and/or stretch by a factor (e.g. 1.001 for 23.976 -> 24 drift). */
export function retime(j: J, o: { by?: number; factor?: number; from?: number }): number {
  let n = 0; for (const s of subtitles(j)) { if (s.start < (o.from ?? 0)) continue; const t = s.ref.seg.target_timerange; t.start = Math.max(0, Math.round(t.start * (o.factor ?? 1) + (o.by ?? 0))); t.duration = Math.max(1, Math.round(t.duration * (o.factor ?? 1))); n++; }
  for (const t of j.tracks) if (isTextTrack(t)) sortTrack(t); recomputeDuration(j); return n;
}
export function removeSub(j: J, n: number): void { const s = pick(j, n); const t = s.ref.track; t.segments.splice(t.segments.indexOf(s.ref.seg), 1); j.materials.texts = (j.materials.texts as J[]).filter((m) => m.id !== s.ref.seg.material_id); recomputeDuration(j); }
/** Make sure no two subtitles on screen overlap and none is shorter than `minUs` (common after imports). */
export function tidy(j: J, minUs = 400_000): number {
  const subs = subtitles(j); let n = 0;
  for (let i = 0; i < subs.length; i++) { const s = subs[i]!, nx = subs[i + 1]; const t = s.ref.seg.target_timerange; if (nx && s.ref.track === nx.ref.track && t.start + t.duration > nx.start) { t.duration = Math.max(1, nx.start - t.start); n++; } if (t.duration < minUs) { const room = nx && s.ref.track === nx.ref.track ? nx.start - t.start : Infinity; t.duration = Math.min(minUs, room); n++; } }
  recomputeDuration(j); return n;
}
