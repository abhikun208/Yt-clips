import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isIP } from 'node:net';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { loadModels, needsUpload, type StudioModel } from './registry.ts';
import { cinemaPrompt, type Camera } from './cinema.ts';
import { Muapi, MuapiError, getKey } from './muapi.ts';
import { info, warn } from '../util/log.ts';

export type InputKind = 'image' | 'audio' | 'video';
export interface UploadRow { id: number; name: string; kind: InputKind; mime: string; path: string; size: number; remote_url: string | null; created_at: string }
export interface GenRow { id: number; studio: string; model: string; kind: string; prompt: string; params_json: string; inputs_json: string; state: string; request_id: string | null; outputs_json: string; files_json: string; cost_json: string | null; error: string | null; created_at: string; updated_at: string }
export interface GenRequest { studio?: string; modelId: string; prompt?: string; params?: Record<string, unknown>; imageIds?: number[]; audioId?: number; videoId?: number; camera?: Camera }
export interface Deps { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv }

const LIMITS: Record<InputKind, number> = { image: 20 * 1024 * 1024, audio: 50 * 1024 * 1024, video: 200 * 1024 * 1024 };
const studioDir = (cfg: Config) => { const d = join(cfg.dataDir, 'studio'); mkdirSync(d, { recursive: true }); return d; };

/** Content sniffing by magic bytes: a renamed .exe never gets stored as an "image". */
export function sniff(b: Buffer): { kind: InputKind; mime: string; ext: string } | null {
  const h = (s: string, o = 0) => b.subarray(o, o + s.length).toString('latin1') === s;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && h('PNG', 1)) return { kind: 'image', mime: 'image/png', ext: '.png' };
  if (b[0] === 0xff && b[1] === 0xd8) return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  if (h('GIF8')) return { kind: 'image', mime: 'image/gif', ext: '.gif' };
  if (h('RIFF') && h('WEBP', 8)) return { kind: 'image', mime: 'image/webp', ext: '.webp' };
  if (h('RIFF') && h('WAVE', 8)) return { kind: 'audio', mime: 'audio/wav', ext: '.wav' };
  if (h('ID3') || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', ext: '.mp3' };
  if (h('OggS')) return { kind: 'audio', mime: 'audio/ogg', ext: '.ogg' };
  if (h('fLaC')) return { kind: 'audio', mime: 'audio/flac', ext: '.flac' };
  if (h('ftyp', 4)) { const brand = b.subarray(8, 12).toString('latin1'); return /^(M4A|M4B)/.test(brand) ? { kind: 'audio', mime: 'audio/mp4', ext: '.m4a' } : { kind: 'video', mime: 'video/mp4', ext: '.mp4' }; }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', mime: 'video/webm', ext: '.webm' };
  return null;
}

export function saveUpload(store: Store, cfg: Config, name: string, data: Buffer): UploadRow {
  const t = sniff(data); if (!t) throw new Error('invalid: unsupported file (use PNG/JPEG/WebP/GIF, MP3/WAV/M4A/OGG/FLAC, MP4/WebM)');
  if (data.length > LIMITS[t.kind]) throw new Error(`invalid: ${t.kind} too large (max ${LIMITS[t.kind] / 1048576} MB)`);
  const clean = basename(name).replace(/[^\w.\- ]+/g, '_').replace(/\.[^.]*$/, '').slice(0, 60) || t.kind;
  const id = store.exec('INSERT INTO studio_uploads(name, kind, mime, path, size) VALUES (?,?,?,?,?)', `${clean}${t.ext}`, t.kind, t.mime, '', data.length).lastId;
  const dir = join(studioDir(cfg), 'uploads'); mkdirSync(dir, { recursive: true }); const path = join(dir, `${id}${t.ext}`); writeFileSync(path, data);
  store.exec('UPDATE studio_uploads SET path=? WHERE id=?', path, id); return store.get<UploadRow>('SELECT * FROM studio_uploads WHERE id=?', id)!;
}
export const listUploads = (store: Store, kind?: string, limit = 60): UploadRow[] => store.all<UploadRow>(`SELECT * FROM studio_uploads ${kind ? 'WHERE kind=?' : ''} ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, limit))}`, ...(kind ? [kind] : []));
export function deleteUpload(store: Store, id: number): boolean { const u = store.get<UploadRow>('SELECT * FROM studio_uploads WHERE id=?', id); if (!u) return false; rmSync(u.path, { force: true }); store.exec('DELETE FROM studio_uploads WHERE id=?', id); return true; }

const coerce = (m: StudioModel, given: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const p of m.params) {
    const v = given[p.name] ?? p.default; if (v === undefined || v === '') continue;
    if (p.type === 'select') { if (!p.options?.includes(String(v))) throw new Error(`invalid: ${p.label} must be one of ${p.options?.join(', ')}`); out[p.name] = /^\d+$/.test(String(v)) && p.name !== 'resolution' ? Number(v) : String(v); }
    else if (p.type === 'int') { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw new Error(`invalid: ${p.label} must be a number`); out[p.name] = Math.min(p.max ?? 1e6, Math.max(p.min ?? -1e6, n)); }
    else out[p.name] = String(v).slice(0, 200);
  }
  return out;
};

/** Validates everything BEFORE a billable call: model, inputs match the model's mode, daily limit, key. */
export function validate(store: Store, cfg: Config, req: GenRequest, deps: Deps = {}): { model: StudioModel; prompt: string; params: Record<string, unknown>; images: UploadRow[]; audio?: UploadRow; video?: UploadRow } {
  const model = loadModels(cfg.dataDir).find((m) => m.id === req.modelId); if (!model) throw new Error('invalid: unknown model (see Settings → models)');
  const get = (id: number | undefined, kind: InputKind): UploadRow | undefined => { if (id === undefined) return undefined; const u = store.get<UploadRow>('SELECT * FROM studio_uploads WHERE id=?', id); if (!u || u.kind !== kind) throw new Error(`invalid: ${kind} upload #${id} not found`); return u; };
  const images = (req.imageIds ?? []).slice(0, 8).map((i) => get(i, 'image')!); const audio = get(req.audioId, 'audio'); const video = get(req.videoId, 'video');
  if (!needsUpload(model) && (images.length || audio || video)) throw new Error('invalid: this model is text-only: remove the uploads or pick an upload-mode model');
  if (model.image !== 'none' && !images.length) throw new Error('invalid: this model needs an image (upload mode)');
  if (model.image === 'single' && images.length > 1) throw new Error('invalid: this model takes one image');
  if (model.image === 'none' && images.length) throw new Error('invalid: this model does not take images');
  if (model.audio && !audio) throw new Error('invalid: this model needs an audio file');
  if (model.video && !video) throw new Error('invalid: this model needs a video file');
  let prompt = String(req.prompt ?? '').trim().slice(0, 3000);
  if (req.camera) prompt = cinemaPrompt(prompt, req.camera).slice(0, 3000);
  const promptOptional = model.kind === 'lipsync_image' || model.kind === 'lipsync_video';
  if (!promptOptional && prompt.length < 2) throw new Error('invalid: write a prompt (2+ characters)');
  if (!getKey(cfg, deps.env)) throw new Error('invalid: add your Muapi API key first (Settings)');
  const today = store.get<{ n: number }>(`SELECT count(*) n FROM studio_generations WHERE created_at >= date('now') AND NOT (state='FAILED' AND request_id IS NULL)`)!.n;
  if (today >= cfg.studio.dailyLimit) throw new Error(`invalid: daily limit of ${cfg.studio.dailyLimit} generations reached (set studio.dailyLimit in data/config.json to change)`);
  return { model, prompt, params: coerce(model, req.params ?? {}), images, audio, video };
}

export function startGeneration(store: Store, cfg: Config, req: GenRequest, deps: Deps = {}): number {
  const v = validate(store, cfg, req, deps);
  const studio = req.camera ? 'cinema' : v.model.studio;
  const id = store.exec('INSERT INTO studio_generations(studio, model, kind, prompt, params_json, inputs_json, state) VALUES (?,?,?,?,?,?,?)', studio, v.model.id, v.model.kind, v.prompt, JSON.stringify(v.params), JSON.stringify({ images: v.images.map((x) => x.id), audio: v.audio?.id, video: v.video?.id, camera: req.camera ?? null }), 'QUEUED').lastId;
  void runGeneration(store, cfg, id, deps).catch((e) => warn('studio run crashed', { id, err: (e as Error).message.slice(0, 120) }));
  return id;
}

const running = new Set<number>();
const upd = (store: Store, id: number, sets: Record<string, unknown>) => { const k = Object.keys(sets); store.exec(`UPDATE studio_generations SET ${k.map((x) => `${x}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`, ...k.map((x) => sets[x] as never), id); };

/** SSRF guard for result downloads: https only, a real DNS host (no IPs/localhost/internal names). */
export function safeResultUrl(u: string): URL | null { try { const x = new URL(u); if (x.protocol !== 'https:' || isIP(x.hostname) || x.hostname === 'localhost' || !x.hostname.includes('.') || /\.(local|internal|lan|home|localdomain)$/i.test(x.hostname) || x.username || x.password) return null; return x; } catch { return null; } }
const OUT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.mp3', '.wav']);

async function download(url: string, dir: string, n: number, fetchFn: typeof fetch): Promise<string> {
  const u = safeResultUrl(url); if (!u) throw new Error('result URL rejected (not a public https host)');
  const r = await fetchFn(u, { signal: AbortSignal.timeout(10 * 60_000) }); if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
  if (r.url && !safeResultUrl(r.url)) throw new Error('download redirected to a non-public host');
  let ext = extname(u.pathname).toLowerCase(); if (!OUT_EXT.has(ext)) { const ct = r.headers.get('content-type') ?? ''; ext = /mp4|video/.test(ct) ? '.mp4' : /webp/.test(ct) ? '.webp' : /jpe?g/.test(ct) ? '.jpg' : /mpeg|audio/.test(ct) ? '.mp3' : '.png'; }
  const file = join(dir, `out_${n}${ext}`); const max = 1024 * 1024 * 1024; let size = 0;
  const guard = new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) { size += c.length; if (size > max) throw new Error('result too large'); ctl.enqueue(c); } });
  await pipeline(Readable.fromWeb(r.body.pipeThrough(guard) as never), createWriteStream(file)); return file;
}

export async function runGeneration(store: Store, cfg: Config, id: number, deps: Deps = {}): Promise<void> {
  if (running.has(id)) return; running.add(id);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))); const fetchFn = deps.fetchFn ?? fetch;
  try {
    const g = store.get<GenRow>('SELECT * FROM studio_generations WHERE id=?', id); if (!g || g.state === 'DONE' || g.state === 'FAILED') return;
    const key = getKey(cfg, deps.env); if (!key) { upd(store, id, { state: 'FAILED', error: 'Muapi API key missing' }); return; }
    const api = new Muapi(cfg, key, fetchFn); const model = loadModels(cfg.dataDir).find((m) => m.id === g.model);
    if (!model) { upd(store, id, { state: 'FAILED', error: 'model no longer in the list' }); return; }
    let reqId = g.request_id;
    if (!reqId) { // fresh job: upload inputs, build the body, submit exactly once
      try {
        const inp = JSON.parse(g.inputs_json) as { images?: number[]; audio?: number; video?: number };
        const urlOf = async (uid: number): Promise<string> => { const u = store.get<UploadRow>('SELECT * FROM studio_uploads WHERE id=?', uid); if (!u) throw new Error(`upload #${uid} was deleted`); if (u.remote_url) return u.remote_url; const url = await api.upload(u.name, u.mime, readFileSync(u.path)); store.exec('UPDATE studio_uploads SET remote_url=? WHERE id=?', url, uid); return url; };
        upd(store, id, { state: 'RUNNING' });
        const body: Record<string, unknown> = { ...JSON.parse(g.params_json) as Record<string, unknown> }; if (g.prompt) body.prompt = g.prompt;
        if (inp.images?.length) { const urls = []; for (const i of inp.images) urls.push(await urlOf(i)); if (model.image === 'multi') body[model.imageField ?? 'images_list'] = urls; else body[model.imageField ?? 'image_url'] = urls[0]; }
        if (inp.audio !== undefined) body.audio_url = await urlOf(inp.audio);
        if (inp.video !== undefined) body.video_url = await urlOf(inp.video);
        reqId = await api.submit(model.endpoint ?? model.id, body); upd(store, id, { request_id: reqId });
      } catch (e) { upd(store, id, { state: 'FAILED', error: (e as Error).message.slice(0, 300) }); return; }
    } else upd(store, id, { state: 'RUNNING' });
    const deadline = Date.now() + (model.studio === 'image' ? 6 : 30) * 60_000; let fails = 0;
    while (Date.now() < deadline) {
      let r; try { r = await api.result(reqId); fails = 0; } catch (e) { if (e instanceof MuapiError && e.status >= 400 && e.status < 500 && e.status !== 429) { upd(store, id, { state: 'FAILED', error: e.message }); return; } if (++fails >= 8) { upd(store, id, { state: 'FAILED', error: `lost contact with Muapi: ${(e as Error).message.slice(0, 120)} (request ${reqId} may still finish: Retry later)` }); return; } await sleep(cfg.studio.pollMs * 2); continue; }
      if (r.status === 'failed' || r.status === 'error') { upd(store, id, { state: 'FAILED', error: r.error ?? 'generation failed', cost_json: r.cost ? JSON.stringify(r.cost) : null }); return; }
      if (r.status === 'completed' || r.status === 'succeeded') {
        const dir = join(studioDir(cfg), 'out', String(id)); mkdirSync(dir, { recursive: true }); const files: string[] = [];
        try { for (const [n, u] of r.outputs.entries()) files.push(await download(u, dir, n + 1, fetchFn)); } catch (e) { upd(store, id, { state: 'FAILED', error: `finished, but saving the result failed: ${(e as Error).message.slice(0, 120)}`, outputs_json: JSON.stringify(r.outputs) }); return; }
        if (!files.length) { upd(store, id, { state: 'FAILED', error: 'Muapi returned no output' }); return; }
        upd(store, id, { state: 'DONE', outputs_json: JSON.stringify(r.outputs), files_json: JSON.stringify(files), cost_json: r.cost ? JSON.stringify(r.cost) : null, error: null }); info('studio done', { id, model: model.id, files: files.length }); return;
      }
      await sleep(cfg.studio.pollMs);
    }
    upd(store, id, { state: 'FAILED', error: `timed out waiting for Muapi (request ${reqId}); it may still finish` });
  } finally { running.delete(id); }
}

/** After a restart: jobs that already have a request id are polled again; jobs that never got one were never billed → closed. */
export function resumeStudio(store: Store, cfg: Config, deps: Deps = {}): number {
  store.exec(`UPDATE studio_generations SET state='FAILED', error='interrupted before it was sent (not billed): generate again', updated_at=datetime('now') WHERE state IN ('QUEUED','RUNNING') AND request_id IS NULL`);
  const rows = store.all<{ id: number }>(`SELECT id FROM studio_generations WHERE state IN ('QUEUED','RUNNING') AND request_id IS NOT NULL`);
  for (const r of rows) void runGeneration(store, cfg, r.id, deps).catch(() => undefined); return rows.length;
}

export const getGeneration = (store: Store, id: number) => store.get<GenRow>('SELECT * FROM studio_generations WHERE id=?', id);
export const listGenerations = (store: Store, studio?: string, limit = 60): GenRow[] => store.all<GenRow>(`SELECT * FROM studio_generations ${studio ? 'WHERE studio=?' : ''} ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, limit))}`, ...(studio ? [studio] : []));
export function deleteGeneration(store: Store, cfg: Config, id: number): boolean { const g = getGeneration(store, id); if (!g || g.state === 'RUNNING' || g.state === 'QUEUED') return false; rmSync(join(studioDir(cfg), 'out', String(id)), { recursive: true, force: true }); store.exec('DELETE FROM studio_generations WHERE id=?', id); return true; }
/** Full-resolution result file n (1-based) of a generation, only if it lives inside our studio folder. */
export function resultFile(store: Store, cfg: Config, id: number, n: number): { path: string; name: string } | null {
  const g = getGeneration(store, id); if (!g) return null; const files = JSON.parse(g.files_json) as string[]; const f = files[n - 1]; if (!f) return null;
  const root = join(studioDir(cfg), 'out'); if (!f.startsWith(root + '/') || !existsSync(f) || !statSync(f).isFile()) return null; return { path: f, name: `studio-${id}-${n}${extname(f)}` };
}
export function uploadFile(store: Store, cfg: Config, id: number): UploadRow | null { const u = store.get<UploadRow>('SELECT * FROM studio_uploads WHERE id=?', id); if (!u || !u.path.startsWith(join(studioDir(cfg), 'uploads') + '/') || !existsSync(u.path)) return null; return u; }
