import { writeFileSync, readFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { J } from './draft.ts';
import { uuid, materialsOf, recomputeDuration } from './model.ts';
import type { Probe } from './media.ts';

const CATS = ['videos', 'audios', 'texts', 'stickers', 'speeds', 'canvases', 'transitions', 'video_effects', 'effects', 'material_animations', 'audio_fades', 'beats', 'placeholder_infos', 'vocal_separations', 'sound_channel_mappings', 'masks', 'common_masks', 'smart_crops', 'manual_deformations'];

/** A fresh plaintext draft. UNVERIFIED in the real app (built from the published draft format, never opened in CapCut by the author of this tool): prefer `seed` (an app-made draft) so every app-specific field comes from CapCut itself. */
export function blankDraft(o: { name: string; width: number; height: number; fps: number; seed?: J }): J {
  if (o.seed) {
    const j: J = JSON.parse(JSON.stringify(o.seed)); j.id = uuid(); j.name = o.name; j.tracks = []; for (const k of Object.keys(j.materials ?? {})) if (Array.isArray(j.materials[k])) j.materials[k] = []; j.duration = 0;
    if (!j.canvas_config) j.canvas_config = {}; Object.assign(j.canvas_config, { width: o.width, height: o.height, ratio: 'original' }); j.fps = o.fps; return j;
  }
  return { id: uuid(), name: o.name, version: 360000, new_version: '110.0.0', duration: 0, fps: o.fps, canvas_config: { width: o.width, height: o.height, ratio: 'original' }, platform: { app_source: 'cc', app_version: '5.9.0', os: 'windows' }, last_modified_platform: { app_source: 'cc', app_version: '5.9.0', os: 'windows' }, create_time: 0, update_time: 0, tracks: [], materials: Object.fromEntries(CATS.map((c) => [c, []])), extra_info: null, free_render_index_mode_on: false, keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] }, config: { adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1, lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [], maintrack_adsorb: true, material_save_mode: 0, original_sound_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_recognition_id: '', subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [], video_mute: false, zoom_info_params: null }, color_space: 0, render_index_track_mode_on: false, retouch_cover: null, source: 'default', static_cover_image_path: '', time_marks: null, mutable_config: null, cover: null };
}
const CROP = { lower_left_x: 0.0, lower_left_y: 1.0, lower_right_x: 1.0, lower_right_y: 1.0, upper_left_x: 0.0, upper_left_y: 0.0, upper_right_x: 1.0, upper_right_y: 0.0 };

/** How much to enlarge the picture so it FILLS the canvas (cut-off edges) instead of fitting inside it. CapCut's scale 1 = fit. */
export function fillScale(srcW: number, srcH: number, cw: number, ch: number): number { if (!srcW || !srcH) return 1; const fit = Math.min(cw / srcW, ch / srcH), fill = Math.max(cw / srcW, ch / srcH); return Math.round((fill / fit) * 10000) / 10000; }

export function addTrack(j: J, type: string, name = ''): J { const t = { id: uuid(), type, name, segments: [], attribute: 0, flag: 0, is_default_name: !name }; j.tracks.push(t); return t; }

export function addVideo(j: J, p: Probe, o: { srcStart?: number; srcDur?: number; at?: number; track?: J; fill?: boolean; x?: number } = {}): J {
  const mat = { id: uuid(), type: p.isImage ? 'photo' : 'video', path: p.path, material_name: p.name, duration: p.isImage ? 10_800_000_000 : p.duration, width: p.width, height: p.height, has_audio: p.hasAudio, category_name: 'local', category_id: '', check_flag: 63487, crop: { ...CROP }, crop_ratio: 'free', crop_scale: 1.0, local_material_id: '', material_id: '', media_path: '', extra_type_option: 0 };
  materialsOf(j, 'videos').push(mat); const sp = { id: uuid(), type: 'speed', mode: 0, speed: 1.0, curve_speed: null }; materialsOf(j, 'speeds').push(sp);
  const start = o.srcStart ?? 0, dur = o.srcDur ?? p.duration - start; const track = o.track ?? j.tracks.find((t: J) => t.type === 'video') ?? addTrack(j, 'video');
  const sc = o.fill ? fillScale(p.width, p.height, j.canvas_config.width, j.canvas_config.height) : 1;
  const seg = { id: uuid(), material_id: mat.id, target_timerange: { start: o.at ?? 0, duration: dur }, source_timerange: { start, duration: dur }, speed: 1.0, volume: 1.0, visible: true, render_index: 0, track_render_index: 0, extra_material_refs: [sp.id], clip: { alpha: 1.0, flip: { horizontal: false, vertical: false }, rotation: 0.0, scale: { x: sc, y: sc }, transform: { x: o.x ?? 0.0, y: 0.0 } }, uniform_scale: { on: true, value: 1.0 }, common_keyframes: [], keyframe_refs: [], enable_adjust: true };
  track.segments.push(seg); recomputeDuration(j); return seg;
}
export function addAudio(j: J, p: Probe, o: { at?: number; srcStart?: number; srcDur?: number; volume?: number } = {}): J {
  const mat = { id: uuid(), type: 'extract_music', path: p.path, name: p.name, duration: p.duration, check_flag: 1, category_name: 'local', category_id: '', local_material_id: '', music_id: uuid(), wave_points: [] }; materialsOf(j, 'audios').push(mat);
  const sp = { id: uuid(), type: 'speed', mode: 0, speed: 1.0, curve_speed: null }; materialsOf(j, 'speeds').push(sp); const track = j.tracks.find((t: J) => t.type === 'audio') ?? addTrack(j, 'audio');
  const start = o.srcStart ?? 0, dur = o.srcDur ?? p.duration - start;
  const seg = { id: uuid(), material_id: mat.id, target_timerange: { start: o.at ?? 0, duration: dur }, source_timerange: { start, duration: dur }, speed: 1.0, volume: o.volume ?? 1.0, visible: true, extra_material_refs: [sp.id], clip: null, common_keyframes: [], keyframe_refs: [], enable_adjust: true }; track.segments.push(seg); recomputeDuration(j); return seg;
}

/** draft_meta_info.json: registers the media so CapCut lists it in the project (without it clips can show as missing). */
export function writeMeta(dir: string, j: J, probes: Probe[]): void {
  const now = Math.floor(Date.now() / 1000) * 1_000_000; const f = join(dir, 'draft_meta_info.json');
  const meta = { draft_id: j.id, draft_name: j.name, draft_root_path: dir, draft_fold_path: dir, tm_draft_create: now, tm_draft_modified: now, tm_duration: j.duration, draft_cover: '', draft_materials: [{ type: 0, value: probes.map((p) => ({ id: uuid(), file_Path: p.path, extra_info: p.name, duration: p.duration, width: p.width, height: p.height, metetype: p.isImage ? 'photo' : p.hasAudio || !p.width ? (p.width ? 'video' : 'music') : 'video', type: 0, import_time: Math.floor(Date.now() / 1000), create_time: Math.floor(Date.now() / 1000) })) }, { type: 1, value: [] }, { type: 2, value: [] }, { type: 3, value: [] }, { type: 6, value: [] }, { type: 7, value: [] }, { type: 8, value: [] }] };
  writeFileSync(f, JSON.stringify(meta, null, 2));
}
export function writeNewDraft(dir: string, j: J, probes: Probe[], seedDir?: string): void {
  if (seedDir && existsSync(seedDir)) for (const f of readdirSync(seedDir)) if (/^draft_(agency_config|biz_config|settings)/.test(f)) { try { copyFileSync(join(seedDir, f), join(dir, f)); } catch { /* optional sidecar */ } }
  writeFileSync(join(dir, 'draft_content.json'), JSON.stringify(j)); writeMeta(dir, j, probes);
}
void readFileSync; void basename;
