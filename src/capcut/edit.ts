import type { J } from './draft.ts';
import { uuid, findMaterial, materialsOf, recomputeDuration, sortTrack, segEnd, type SegRef } from './model.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const speedOf = (s: J): number => (typeof s.speed === 'number' && s.speed > 0 ? s.speed : 1);

/** Move every later segment of the same track by `delta` (ripple), so edits never leave overlaps or holes. */
function ripple(track: J, after: number, except: J, delta: number): void { if (!delta) return; for (const o of track.segments) if (o !== except && (o.target_timerange?.start ?? 0) >= after) o.target_timerange.start += delta; }

export interface EditResult { message: string }

function speedMaterial(j: J, seg: J, create: boolean): J | null {
  const refs: string[] = seg.extra_material_refs ?? (seg.extra_material_refs = []);
  for (const id of refs) { const f = findMaterial(j, id); if (f && f.kind === 'speeds') return f.mat; }
  if (!create) return null;
  const m = { id: uuid(), type: 'speed', mode: 0, speed: 1.0, curve_speed: null }; materialsOf(j, 'speeds').push(m); refs.push(m.id); return m;
}

export function setSpeed(j: J, r: SegRef, x: number, o: { ripple?: boolean } = {}): EditResult {
  if (!(x >= 0.1 && x <= 100)) throw new Error('speed must be between 0.1 and 100');
  const s = r.seg; if (!s.source_timerange || !s.target_timerange) throw new Error('this segment has no source range (text/sticker): speed does not apply');
  const old = s.target_timerange.duration; const nd = Math.max(1, Math.round(s.source_timerange.duration / x)); const end0 = segEnd(s);
  s.speed = x; const sm = speedMaterial(j, s, true)!; sm.speed = x; if (sm.mode === undefined) sm.mode = 0;
  s.target_timerange.duration = nd; if (o.ripple !== false) ripple(r.track, end0, s, nd - old); recomputeDuration(j);
  return { message: `speed ${x}x: clip is now ${(nd / 1e6).toFixed(2)}s (was ${(old / 1e6).toFixed(2)}s)` };
}

export function setVolume(j: J, r: SegRef, v: number): EditResult {
  if (!(v >= 0 && v <= 10)) throw new Error('volume must be between 0 (mute) and 10 (1 = original)');
  if (r.track.type === 'text' || r.track.type === 'sticker') throw new Error('text/sticker segments have no audio');
  r.seg.volume = v; return { message: `volume ${v === 0 ? 'muted' : v}` };
}

/** Trim by SOURCE times (absolute inside the media). Head/tail helpers cut an amount off either side. */
export function trim(j: J, r: SegRef, o: { start?: number; end?: number; head?: number; tail?: number; ripple?: boolean }): EditResult {
  const s = r.seg; const src = s.source_timerange; if (!src) throw new Error('this segment has no source range: use move/shift for text segments');
  const sp = speedOf(s); const old = s.target_timerange.duration; const end0 = segEnd(s);
  let a = src.start, b = src.start + src.duration;
  if (o.head) a += o.head; if (o.tail) b -= o.tail; if (o.start !== undefined) a = o.start; if (o.end !== undefined) b = o.end;
  const mat = findMaterial(j, s.material_id)?.mat; const total = mat?.duration;
  if (a < 0) throw new Error('trim start is before the beginning of the media'); if (b <= a) throw new Error('trim leaves nothing (end must be after start)');
  if (typeof total === 'number' && total > 0 && b > total + 1000) throw new Error(`trim end is after the end of the media (${(total / 1e6).toFixed(2)}s)`);
  src.start = a; src.duration = b - a; s.target_timerange.duration = Math.max(1, Math.round((b - a) / sp)); if (o.ripple !== false) ripple(r.track, end0, s, s.target_timerange.duration - old); recomputeDuration(j);
  return { message: `source ${(a / 1e6).toFixed(2)}s-${(b / 1e6).toFixed(2)}s, clip is ${(s.target_timerange.duration / 1e6).toFixed(2)}s on the timeline` };
}

export function moveTo(j: J, r: SegRef, to: number, o: { allowOverlap?: boolean } = {}): EditResult {
  if (to < 0) throw new Error('cannot move before 0');
  const s = r.seg; const d = s.target_timerange.duration;
  if (!o.allowOverlap) { const hit = r.track.segments.find((x: J) => x !== s && x.target_timerange.start < to + d && segEnd(x) > to); if (hit) throw new Error('it would overlap another segment on the same track (use --allow-overlap, or move it to another track)'); }
  s.target_timerange.start = to; sortTrack(r.track); recomputeDuration(j); return { message: `moved to ${(to / 1e6).toFixed(2)}s` };
}

/** Shift one segment, a whole track, or everything from a time onward. */
export function shift(j: J, by: number, o: { seg?: SegRef; trackIndex?: number; from?: number }): EditResult {
  let n = 0;
  const apply = (s: J) => { s.target_timerange.start = Math.max(0, s.target_timerange.start + by); n++; };
  if (o.seg) apply(o.seg.seg);
  else for (const [i, t] of (j.tracks as J[]).entries()) { if (o.trackIndex !== undefined && i + 1 !== o.trackIndex) continue; for (const s of t.segments) if ((o.from ?? 0) <= s.target_timerange.start) apply(s); }
  for (const t of j.tracks) sortTrack(t); recomputeDuration(j); return { message: `shifted ${n} segment(s) by ${(by / 1e6).toFixed(3)}s` };
}

function cloneExtras(j: J, seg: J): void {
  const refs: string[] = seg.extra_material_refs ?? []; seg.extra_material_refs = refs.map((id) => { const f = findMaterial(j, id); if (!f) return id; const c = clone(f.mat); c.id = uuid(); materialsOf(j, f.kind).push(c); return c.id; });
}
/** Split one segment at a timeline time into two (both keep the same media and settings). */
export function split(j: J, r: SegRef, at: number): EditResult {
  const s = r.seg; const t = s.target_timerange; if (at <= t.start + 1000 || at >= segEnd(s) - 1000) throw new Error('split point must be inside the segment');
  const sp = speedOf(s); const first = at - t.start; const b = clone(s); b.id = uuid();
  if (s.source_timerange) { const srcCut = Math.round(first * sp); b.source_timerange = { start: s.source_timerange.start + srcCut, duration: s.source_timerange.duration - srcCut }; s.source_timerange.duration = srcCut; }
  b.target_timerange = { start: at, duration: segEnd(s) - at }; t.duration = first; cloneExtras(j, b); r.track.segments.push(b); sortTrack(r.track); recomputeDuration(j);
  return { message: `split at ${(at / 1e6).toFixed(2)}s into two clips` };
}

export function remove(j: J, r: SegRef, o: { ripple?: boolean } = {}): EditResult {
  const s = r.seg; const d = s.target_timerange.duration; const end = segEnd(s);
  r.track.segments.splice(r.track.segments.indexOf(s), 1);
  for (const id of s.extra_material_refs ?? []) { const f = findMaterial(j, id); if (f) { const arr = materialsOf(j, f.kind); arr.splice(arr.indexOf(f.mat), 1); } }
  if (o.ripple) ripple(r.track, end, s, -d); recomputeDuration(j);
  return { message: `deleted${o.ripple ? ' (gap closed)' : ''}` };
}

/** Close every gap on one track so clips play back to back. */
export function closeGaps(j: J, trackIndex: number): EditResult {
  const t = j.tracks[trackIndex - 1]; if (!t) throw new Error('no such track'); sortTrack(t); let at = 0, n = 0;
  for (const s of t.segments) { if (s.target_timerange.start !== at) { s.target_timerange.start = at; n++; } at += s.target_timerange.duration; } recomputeDuration(j); return { message: `closed ${n} gap(s)` };
}
