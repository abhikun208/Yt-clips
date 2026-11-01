import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { loadModels, needsUpload } from './registry.ts';
import { CINEMA, cinemaPrompt, type Camera } from './cinema.ts';
import { getKey, setKey, clearKey } from './muapi.ts';
import { readFileSync } from 'node:fs';
import { saveUpload, listUploads, deleteUpload, uploadFile, startGeneration, listGenerations, getGeneration, deleteGeneration, resultFile, type Deps, type GenRequest, type GenRow } from './service.ts';

export interface Ctx {
  req: IncomingMessage; res: ServerResponse; p: string; m: string; url: URL; store: Store; cfg: Config; deps: Deps;
  json: (res: ServerResponse, code: number, body: unknown, extra?: Record<string, string>) => void;
  readBody: (req: IncomingMessage, max: number) => Promise<Buffer>;
  sendPath: (req: IncomingMessage, res: ServerResponse, full: string, type: string, download?: string) => void;
}
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const view = (g: GenRow) => { const files = JSON.parse(g.files_json) as string[]; return { id: g.id, studio: g.studio, model: g.model, kind: g.kind, prompt: g.prompt, params: JSON.parse(g.params_json), inputs: JSON.parse(g.inputs_json), state: g.state, error: g.error, cost: g.cost_json ? JSON.parse(g.cost_json) : null, createdAt: g.created_at, files: files.map((f, i) => ({ n: i + 1, url: `/api/studio/files/${g.id}/${i + 1}`, download: `/api/studio/files/${g.id}/${i + 1}?download=1`, type: TYPES[f.slice(f.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream' })) }; };

/** Returns true when it answered. Everything here is behind the normal auth; the Muapi key is write-only (never returned). */
export async function handleStudio(c: Ctx): Promise<boolean> {
  const { p, m, req, res, store, cfg, json } = c; if (!p.startsWith('/api/studio/')) return false;
  if (p === '/api/studio/models' && m === 'GET') {
    const used = store.get<{ n: number }>(`SELECT count(*) n FROM studio_generations WHERE created_at >= date('now') AND NOT (state='FAILED' AND request_id IS NULL)`)!.n;
    json(res, 200, { models: loadModels(cfg.dataDir).map((x) => ({ ...x, upload: needsUpload(x) })), keyConfigured: !!getKey(cfg, c.deps.env), dailyLimit: cfg.studio.dailyLimit, usedToday: used, cinema: Object.fromEntries(Object.entries(CINEMA).map(([k, v]) => [k, Object.keys(v)])) }); return true;
  }
  if (p === '/api/studio/cinema-preview' && m === 'POST') { const b = JSON.parse((await c.readBody(req, 16 * 1024)).toString('utf8') || '{}') as { prompt?: string; camera?: Camera }; json(res, 200, { prompt: cinemaPrompt(String(b.prompt ?? ''), b.camera && typeof b.camera === 'object' ? b.camera : {}) }); return true; }
  if (p === '/api/studio/key' && m === 'POST') { const b = JSON.parse((await c.readBody(req, 4096)).toString('utf8') || '{}') as { key?: string }; try { setKey(cfg, String(b.key ?? '').trim()); } catch (e) { json(res, 400, { error: (e as Error).message }); return true; } json(res, 200, { ok: true }); return true; }
  if (p === '/api/studio/key' && m === 'DELETE') { clearKey(cfg); json(res, 200, { ok: true }); return true; }
  if (p === '/api/studio/upload' && m === 'POST') {
    const body = await c.readBody(req, 200 * 1024 * 1024);
    try { const u = saveUpload(store, cfg, c.url.searchParams.get('name') ?? 'upload', body); json(res, 200, { upload: { id: u.id, name: u.name, kind: u.kind, size: u.size, url: `/api/studio/uploads/${u.id}/file` } }); } catch (e) { json(res, 400, { error: (e as Error).message }); } return true;
  }
  if (p === '/api/studio/uploads' && m === 'GET') { json(res, 200, { uploads: listUploads(store, c.url.searchParams.get('kind') ?? undefined).map((u) => ({ id: u.id, name: u.name, kind: u.kind, size: u.size, createdAt: u.created_at, url: `/api/studio/uploads/${u.id}/file` })) }); return true; }
  const um = /^\/api\/studio\/uploads\/(\d+)(\/file)?$/.exec(p);
  if (um) {
    const id = Number(um[1]);
    if (um[2] && m === 'GET') { const u = uploadFile(store, cfg, id); if (!u) { json(res, 404, { error: 'not found' }); return true; } c.sendPath(req, res, u.path, u.mime); return true; }
    if (!um[2] && m === 'DELETE') { json(res, deleteUpload(store, id) ? 200 : 404, { ok: true }); return true; }
  }
  if (p === '/api/studio/generate' && m === 'POST') {
    const b = JSON.parse((await c.readBody(req, 64 * 1024)).toString('utf8') || '{}') as GenRequest;
    try { const id = startGeneration(store, cfg, { modelId: String(b.modelId ?? ''), prompt: b.prompt, params: b.params && typeof b.params === 'object' ? b.params : {}, imageIds: Array.isArray(b.imageIds) ? b.imageIds.map(Number).filter(Number.isInteger) : [], audioId: b.audioId === undefined || b.audioId === null ? undefined : Number(b.audioId), videoId: b.videoId === undefined || b.videoId === null ? undefined : Number(b.videoId), camera: b.camera && typeof b.camera === 'object' ? b.camera : undefined }, c.deps); json(res, 200, { id }); } catch (e) { json(res, 400, { error: (e as Error).message }); } return true;
  }
  if (p === '/api/studio/generations' && m === 'GET') { json(res, 200, { generations: listGenerations(store, c.url.searchParams.get('studio') ?? undefined, Number(c.url.searchParams.get('limit') ?? 60)).map(view) }); return true; }
  const useM = /^\/api\/studio\/generations\/(\d+)\/use\/(\d+)$/.exec(p); // chain: a result becomes an input (image -> video, audio -> lip sync ...)
  if (useM && m === 'POST') { const f = resultFile(store, cfg, Number(useM[1]), Number(useM[2])); if (!f) { json(res, 404, { error: 'not found' }); return true; } try { const u = saveUpload(store, cfg, f.name, readFileSync(f.path)); json(res, 200, { upload: { id: u.id, name: u.name, kind: u.kind, size: u.size, url: `/api/studio/uploads/${u.id}/file` } }); } catch (e) { json(res, 400, { error: (e as Error).message }); } return true; }
  const gm = /^\/api\/studio\/generations\/(\d+)$/.exec(p);
  if (gm) { const id = Number(gm[1]); if (m === 'GET') { const g = getGeneration(store, id); json(res, g ? 200 : 404, g ? { generation: view(g) } : { error: 'not found' }); return true; } if (m === 'DELETE') { json(res, deleteGeneration(store, cfg, id) ? 200 : 409, { ok: true }); return true; } }
  const fm = /^\/api\/studio\/files\/(\d+)\/(\d+)$/.exec(p);
  if (fm && m === 'GET') { const f = resultFile(store, cfg, Number(fm[1]), Number(fm[2])); if (!f) { json(res, 404, { error: 'not found' }); return true; } c.sendPath(req, res, f.path, TYPES[f.path.slice(f.path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream', c.url.searchParams.get('download') ? f.name : undefined); return true; }
  json(res, 404, { error: 'not found' }); return true;
}
