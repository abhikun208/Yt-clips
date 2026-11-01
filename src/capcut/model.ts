import { randomUUID } from 'node:crypto';
import type { Draft, J } from './draft.ts';
import { fmt } from './time.ts';

export const uuid = (): string => randomUUID().toUpperCase();
export type TrackType = 'video' | 'audio' | 'text' | 'sticker' | 'effect' | 'filter' | 'image' | 'subtitle' | string;

export const materialsOf = (j: J, kind: string): J[] => (Array.isArray(j.materials?.[kind]) ? j.materials[kind] : (j.materials[kind] = []));
export function findMaterial(j: J, id: string): { kind: string; mat: J } | null {
  for (const [kind, arr] of Object.entries(j.materials ?? {})) if (Array.isArray(arr)) { const m = (arr as J[]).find((x) => x?.id === id); if (m) return { kind, mat: m }; }
  return null;
}
export const segEnd = (s: J): number => (s.target_timerange?.start ?? 0) + (s.target_timerange?.duration ?? 0);
export const timelineEnd = (j: J): number => Math.max(0, ...j.tracks.flatMap((t: J) => t.segments.map(segEnd)));
export const isTextTrack = (t: J): boolean => t.type === 'text' || t.type === 'subtitle';

/** Short reference used in the terminal: "2:5" = track 2, segment 5 (1-based, segments in time order). */
export interface SegRef { ti: number; si: number; track: J; seg: J; ref: string }
export function allSegments(j: J): SegRef[] {
  const out: SegRef[] = [];
  j.tracks.forEach((track: J, ti: number) => { sortedIdx(track).forEach((real, si) => out.push({ ti: ti + 1, si: si + 1, track, seg: track.segments[real], ref: `${ti + 1}:${si + 1}` })); });
  return out;
}
const sortedIdx = (t: J): number[] => t.segments.map((_: J, i: number) => i).sort((a: number, b: number) => (t.segments[a].target_timerange?.start ?? 0) - (t.segments[b].target_timerange?.start ?? 0));
/** Keep the array in time order (CapCut expects it) after an edit. */
export const sortTrack = (t: J): void => { t.segments.sort((a: J, b: J) => (a.target_timerange?.start ?? 0) - (b.target_timerange?.start ?? 0)); };

export function findSegment(j: J, ref: string): SegRef {
  const all = allSegments(j); const m = /^(\d+):(\d+)$/.exec(ref.trim());
  const hit = m ? all.find((x) => x.ti === Number(m[1]) && x.si === Number(m[2])) : all.find((x) => x.seg.id === ref || String(x.seg.id).toLowerCase().startsWith(ref.toLowerCase()) && ref.length >= 6);
  if (!hit) throw new Error(`segment "${ref}" not found (use track:index like 1:3, or an id prefix; see: capcut segments <draft>)`);
  return hit;
}

export function recomputeDuration(j: J): number { const d = timelineEnd(j); j.duration = d; return d; }

/* ---------- text materials ---------- */
export function textMaterialOf(j: J, seg: J): J | null { const f = findMaterial(j, seg.material_id); return f && f.kind === 'texts' ? f.mat : null; }
/** The visible text of a text material (its `content` is JSON inside JSON; older drafts keep plain text). */
export function getText(mat: J): string { try { const c = JSON.parse(mat.content); if (typeof c.text === 'string') return c.text; } catch { /* plain */ } return typeof mat.content === 'string' ? mat.content : ''; }
/** Replace the text and re-range the style runs so they cover the new length (CapCut ignores/garbles ranges that do not). */
export function setText(mat: J, text: string): void {
  let c: J; try { c = JSON.parse(mat.content); } catch { c = null; }
  if (!c || typeof c !== 'object') { c = { text, styles: [] }; }
  const n = [...text].length; c.text = text;
  if (Array.isArray(c.styles) && c.styles.length) { const first = c.styles[0]; first.range = [0, n]; c.styles = [first]; } else c.styles = [defaultStyleRun(n)];
  mat.content = JSON.stringify(c); if (typeof mat.base_content === 'string') mat.base_content = '';
  if (mat.words && Array.isArray(mat.words.text)) mat.words = { start_time: [], end_time: [], text: [] }; // word-level karaoke timings no longer match
}
export const defaultStyleRun = (n: number): J => ({ fill: { alpha: 1.0, content: { render_type: 'solid', solid: { alpha: 1.0, color: [1.0, 1.0, 1.0] } } }, range: [0, n], size: 8.0, bold: false, italic: false, underline: false, strokes: [{ content: { solid: { alpha: 1.0, color: [0, 0, 0] } }, width: 0.08 }] });

export interface Sub { n: number; ref: SegRef; start: number; end: number; text: string }
/** All subtitle/caption segments (text tracks), in time order, numbered 1..N. */
export function subtitles(j: J): Sub[] {
  const out: Omit<Sub, 'n'>[] = [];
  for (const r of allSegments(j)) { if (!isTextTrack(r.track)) continue; const m = textMaterialOf(j, r.seg); if (!m) continue; out.push({ ref: r, start: r.seg.target_timerange.start, end: segEnd(r.seg), text: getText(m) }); }
  return out.sort((a, b) => a.start - b.start).map((x, i) => ({ ...x, n: i + 1 }));
}

/* ---------- reading ---------- */
export interface Summary { name: string; app: string; version: string; fps: number | null; canvas: string; duration: number; tracks: { n: number; type: string; name: string; segments: number }[]; media: number; subtitles: number; encryptedSidecars: string[]; warnings: string[] }
export function summarize(d: Draft): Summary {
  const j = d.json; const pf = j.platform ?? {}; const app = pf.app_source === 'lv' ? 'JianYing' : pf.app_source === 'cc' ? 'CapCut' : (pf.app_source ?? 'unknown');
  const warnings: string[] = []; if (d.mirrorFile) warnings.push(`${d.fileName} is edited; ${d.mirrorFile.split(/[\\/]/).pop()} also exists and may be a stale mirror`);
  return { name: String(j.name || d.dir.split(/[\\/]/).pop()), app, version: String(pf.app_version ?? j.version ?? ''), fps: typeof j.fps === 'number' ? j.fps : null, canvas: j.canvas_config ? `${j.canvas_config.width}x${j.canvas_config.height}${j.canvas_config.ratio ? ` (${j.canvas_config.ratio})` : ''}` : 'unknown', duration: j.duration ?? timelineEnd(j),
    tracks: j.tracks.map((t: J, i: number) => ({ n: i + 1, type: t.type, name: t.name ?? '', segments: t.segments.length })), media: ['videos', 'audios'].reduce((n, k) => n + (j.materials?.[k]?.length ?? 0), 0), subtitles: subtitles(j).length, encryptedSidecars: [], warnings };
}
export interface MediaRow { id: string; kind: 'video' | 'photo' | 'audio'; name: string; path: string; duration: number; size: string; used: number }
export function mediaList(j: J): MediaRow[] {
  const used = new Map<string, number>(); for (const t of j.tracks) for (const s of t.segments) used.set(s.material_id, (used.get(s.material_id) ?? 0) + 1);
  const rows: MediaRow[] = [];
  for (const m of j.materials?.videos ?? []) rows.push({ id: m.id, kind: m.type === 'photo' ? 'photo' : 'video', name: m.material_name ?? m.name ?? '', path: m.path ?? '', duration: m.duration ?? 0, size: m.width ? `${m.width}x${m.height}` : '', used: used.get(m.id) ?? 0 });
  for (const m of j.materials?.audios ?? []) rows.push({ id: m.id, kind: 'audio', name: m.name ?? m.material_name ?? '', path: m.path ?? '', duration: m.duration ?? 0, size: '', used: used.get(m.id) ?? 0 });
  return rows;
}
export const segLabel = (r: SegRef, j: J): string => { const f = findMaterial(j, r.seg.material_id); const m = f?.mat; return r.track.type === 'text' || r.track.type === 'subtitle' ? (m ? getText(m).replace(/\s+/g, ' ').slice(0, 40) : '') : (m?.material_name ?? m?.name ?? m?.path?.split(/[\\/]/).pop() ?? f?.kind ?? ''); };
export const rangeStr = (r: J): string => (r ? `${fmt(r.start)} +${fmt(r.duration)}` : '-');
