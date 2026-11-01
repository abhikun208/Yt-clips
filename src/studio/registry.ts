import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type StudioName = 'image' | 'video' | 'lipsync';
export type ModelKind = 't2i' | 'i2i' | 't2v' | 'i2v' | 'lipsync_image' | 'lipsync_video';
export interface ParamDef { name: string; label: string; type: 'select' | 'int' | 'text'; options?: string[]; min?: number; max?: number; default?: string | number; note?: string }
export interface StudioModel {
  id: string; label: string; studio: StudioName; kind: ModelKind; verified: 'fields' | 'slug' | 'unverified'; params: ParamDef[];
  image: 'none' | 'single' | 'multi'; imageField?: string; audio: boolean; video: boolean; note?: string; disabled?: boolean; endpoint?: string;
}
const KINDS = new Set<string>(['t2i', 'i2i', 't2v', 'i2v', 'lipsync_image', 'lipsync_video']);
const STUDIOS = new Set<string>(['image', 'video', 'lipsync']);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/;

/** Accepts only well-formed entries (a bad line in the owner's file must never break the app or reach the API path). */
export function normalizeModel(x: unknown): StudioModel | null {
  if (!x || typeof x !== 'object') return null; const r = x as Record<string, unknown>;
  const id = String(r.id ?? ''); if (!SLUG.test(id)) return null;
  const endpoint = r.endpoint === undefined ? undefined : String(r.endpoint); if (endpoint !== undefined && !SLUG.test(endpoint)) return null;
  if (r.disabled === true) return { id, label: id, studio: 'image', kind: 't2i', verified: 'unverified', params: [], image: 'none', audio: false, video: false, disabled: true };
  if (!KINDS.has(String(r.kind)) || !STUDIOS.has(String(r.studio))) return null;
  const image = r.image === 'single' || r.image === 'multi' ? r.image : 'none';
  const imageField = r.imageField === undefined ? undefined : String(r.imageField); if (imageField !== undefined && !/^[a-z_][a-z0-9_]{1,30}$/.test(imageField)) return null;
  const params: ParamDef[] = []; for (const p of Array.isArray(r.params) ? r.params : []) { const q = p as Record<string, unknown>; if (!/^[a-z_][a-z0-9_]{0,30}$/.test(String(q.name)) || !['select', 'int', 'text'].includes(String(q.type))) continue; params.push({ name: String(q.name), label: String(q.label ?? q.name).slice(0, 40), type: q.type as ParamDef['type'], options: Array.isArray(q.options) ? q.options.map(String).slice(0, 30) : undefined, min: typeof q.min === 'number' ? q.min : undefined, max: typeof q.max === 'number' ? q.max : undefined, default: typeof q.default === 'number' || typeof q.default === 'string' ? q.default : undefined, note: q.note ? String(q.note).slice(0, 120) : undefined }); }
  const v = r.verified === 'fields' || r.verified === 'slug' ? r.verified : 'unverified';
  return { id, label: String(r.label ?? id).slice(0, 60), studio: r.studio as StudioName, kind: r.kind as ModelKind, verified: v, params, image, imageField, audio: r.audio === true, video: r.video === true, note: r.note ? String(r.note).slice(0, 200) : undefined, endpoint };
}

/** Built-in list + the owner's data/studio-models.json (same ids replace built-ins; `{id, disabled:true}` hides one). */
export function loadModels(dataDir: string): StudioModel[] {
  const read = (f: string): unknown[] => { try { const j = JSON.parse(readFileSync(f, 'utf8')) as { models?: unknown[] } | unknown[]; return Array.isArray(j) ? j : (j.models ?? []); } catch { return []; } };
  const builtIn = read(new URL('./models.json', import.meta.url).pathname); const mine = existsSync(join(dataDir, 'studio-models.json')) ? read(join(dataDir, 'studio-models.json')) : [];
  const map = new Map<string, StudioModel>(); for (const x of [...builtIn, ...mine]) { const n = normalizeModel(x); if (n) map.set(n.id, n); }
  return [...map.values()].filter((x) => !x.disabled);
}
/** Which input mode a model needs: text-only, or upload (image / audio / video). */
export const needsUpload = (m: StudioModel): boolean => m.image !== 'none' || m.audio || m.video;
