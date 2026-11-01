import { existsSync } from 'node:fs';
import type { J } from './draft.ts';
import { findMaterial, segEnd, timelineEnd, isTextTrack, sortTrack, getText, textMaterialOf } from './model.ts';

export interface Finding { level: 'error' | 'warn' | 'info'; code: string; message: string; fixable: boolean; fix?: () => string }

/** Read-only checks. Findings with fixable=true carry a `fix` closure that edits `j` in memory (the CLI backs up and saves). */
export function diagnose(j: J, o: { checkMedia?: boolean } = {}): Finding[] {
  const out: Finding[] = []; const add = (f: Finding) => out.push(f);
  if (!Array.isArray(j.tracks)) { add({ level: 'error', code: 'no-tracks', message: 'draft has no "tracks" array', fixable: false }); return out; }
  const refd = new Set<string>();
  j.tracks.forEach((t: J, ti: number) => {
    const label = `track ${ti + 1} (${t.type}${t.name ? ' "' + t.name + '"' : ''})`; if (!Array.isArray(t.segments)) return;
    const sorted = [...t.segments].sort((a: J, b: J) => (a.target_timerange?.start ?? 0) - (b.target_timerange?.start ?? 0));
    if (t.segments.some((s: J, i: number) => s !== sorted[i])) add({ level: 'warn', code: 'unsorted', message: `${label}: segments are not in time order`, fixable: true, fix: () => { sortTrack(t); return `sorted ${label}`; } });
    for (let i = 1; i < sorted.length; i++) if (segEnd(sorted[i - 1]) > sorted[i].target_timerange.start + 1) add({ level: 'error', code: 'overlap', message: `${label}: segment ${i} overlaps segment ${i + 1} by ${((segEnd(sorted[i - 1]) - sorted[i].target_timerange.start) / 1e6).toFixed(3)}s`, fixable: false });
    for (const s of t.segments as J[]) {
      for (const id of [s.material_id, ...(s.extra_material_refs ?? [])]) { if (!id) continue; refd.add(id); if (!findMaterial(j, id)) add({ level: 'error', code: 'dangling-ref', message: `${label}: segment ${String(s.id).slice(0, 8)} points to missing material ${String(id).slice(0, 8)}`, fixable: id !== s.material_id, fix: id !== s.material_id ? () => { s.extra_material_refs = s.extra_material_refs.filter((x: string) => x !== id); return `dropped dangling extra ref ${String(id).slice(0, 8)}`; } : undefined }); }
      if (!s.target_timerange || !(s.target_timerange.duration > 0)) add({ level: 'error', code: 'zero-duration', message: `${label}: segment ${String(s.id).slice(0, 8)} has no duration`, fixable: false });
      if (t.type === 'audio' && s.clip != null) add({ level: 'warn', code: 'audio-clip', message: `${label}: audio segment has a "clip" block (CapCut writes null)`, fixable: true, fix: () => { s.clip = null; return 'set audio clip to null'; } });
      if (s.source_timerange && s.target_timerange && !isTextTrack(t)) {
        const sp = typeof s.speed === 'number' && s.speed > 0 ? s.speed : 1; const want = Math.round(s.target_timerange.duration * sp);
        if (Math.abs(s.source_timerange.duration - want) > Math.max(2000, want * 0.002)) add({ level: 'warn', code: 'speed-mismatch', message: `${label}: segment ${String(s.id).slice(0, 8)} source ${(s.source_timerange.duration / 1e6).toFixed(3)}s != timeline ${(s.target_timerange.duration / 1e6).toFixed(3)}s × speed ${sp}`, fixable: true, fix: () => { s.source_timerange.duration = want; return `source duration set to ${(want / 1e6).toFixed(3)}s`; } });
        const m = findMaterial(j, s.material_id)?.mat; if (m && m.type !== 'photo' && typeof m.duration === 'number' && m.duration > 0 && s.source_timerange.start + s.source_timerange.duration > m.duration + 50_000) add({ level: 'warn', code: 'past-media-end', message: `${label}: segment ${String(s.id).slice(0, 8)} reads past the end of its media (${((s.source_timerange.start + s.source_timerange.duration - m.duration) / 1e6).toFixed(2)}s too long)`, fixable: false });
      }
      if (isTextTrack(t)) { const m = textMaterialOf(j, s); if (m) { try { const c = JSON.parse(m.content); const n = [...String(c.text ?? '')].length; const bad = (c.styles ?? []).some((st: J) => Array.isArray(st.range) && (st.range[1] > n || st.range[0] > st.range[1])); if (bad) add({ level: 'warn', code: 'text-range', message: `${label}: a text style range is longer than its text ("${getText(m).slice(0, 25)}")`, fixable: true, fix: () => { for (const st of c.styles) if (Array.isArray(st.range)) st.range = [Math.min(st.range[0], n), Math.min(st.range[1], n)]; m.content = JSON.stringify(c); return 'clamped text style ranges'; } }); } catch { add({ level: 'error', code: 'text-json', message: `${label}: text content is not valid JSON`, fixable: false }); } } }
    }
  });
  const end = timelineEnd(j); if (typeof j.duration === 'number' && Math.abs(j.duration - end) > 1000) add({ level: 'warn', code: 'duration', message: `draft duration ${(j.duration / 1e6).toFixed(3)}s differs from last segment end ${(end / 1e6).toFixed(3)}s`, fixable: true, fix: () => { j.duration = end; return 'draft duration recalculated'; } });
  for (const k of ['texts', 'speeds']) for (const m of (j.materials?.[k] ?? []) as J[]) if (m?.id && !refd.has(m.id)) add({ level: 'info', code: 'orphan', message: `unused ${k.slice(0, -1)} material ${String(m.id).slice(0, 8)}`, fixable: true, fix: () => { j.materials[k] = j.materials[k].filter((x: J) => x.id !== m.id); return `removed unused ${k} ${String(m.id).slice(0, 8)}`; } });
  if (o.checkMedia !== false) for (const k of ['videos', 'audios']) for (const m of (j.materials?.[k] ?? []) as J[]) if (m.path && !existsSync(m.path)) add({ level: 'warn', code: 'missing-media', message: `media file not found: ${m.path} (CapCut will show it as offline; relink in the app or fix the path)`, fixable: false });
  return out;
}
export const summaryLine = (fs: Finding[]): string => { const c = (l: string) => fs.filter((f) => f.level === l).length; return `${c('error')} error(s), ${c('warn')} warning(s), ${c('info')} note(s); ${fs.filter((f) => f.fixable).length} auto-fixable`; };
export function applyFixes(fs: Finding[]): string[] { const done: string[] = []; for (const f of fs) if (f.fixable && f.fix) done.push(f.fix()); return done; }
