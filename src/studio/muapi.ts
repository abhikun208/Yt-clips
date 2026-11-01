import type { Config } from '../config.ts';
import { SecretStore } from '../publish/secrets.ts';

/** Muapi REST client (base https://api.muapi.ai/api/v1, header x-api-key, submit -> request_id, GET /predictions/{id}/result, POST /upload_file). Facts read from Muapi's own docs pages; see PROGRESS 6r. */
const KEY_NAME = 'studio-muapi';
const SAFE_ID = /^[A-Za-z0-9_-]{6,100}$/;
export class MuapiError extends Error { status: number; constructor(msg: string, status = 0) { super(msg); this.status = status; } }

export const keyShapeOk = (k: string) => /^[\x21-\x7e]{12,200}$/.test(k); // printable, no spaces
export function getKey(cfg: Config, env: NodeJS.ProcessEnv = process.env): string | null {
  try { const s = SecretStore.forData(cfg.dataDir).read<{ key?: string }>(KEY_NAME); if (s?.key) return s.key; } catch { /* fall through to env */ }
  const e = (env.MUAPI_API_KEY ?? env.MUAPI_KEY ?? '').trim(); return keyShapeOk(e) ? e : null;
}
export const setKey = (cfg: Config, key: string): void => { if (!keyShapeOk(key)) throw new Error('invalid: key looks wrong (12-200 printable characters, no spaces)'); SecretStore.forData(cfg.dataDir).write(KEY_NAME, { key }); };
export const clearKey = (cfg: Config): void => SecretStore.forData(cfg.dataDir).delete(KEY_NAME);

/** Never let the key (or a provider's echo of it) reach logs/UI. */
const scrub = (s: string, key: string) => s.split(key).join('***').replace(/x-api-key\S*/gi, 'x-api-key ***').slice(0, 300);

export interface PredResult { status: string; outputs: string[]; error?: string; cost?: unknown }
export class Muapi {
  private cfg: Config; private key: string; private fetchFn: typeof fetch;
  constructor(cfg: Config, key: string, fetchFn: typeof fetch = fetch) { this.cfg = cfg; this.key = key; this.fetchFn = fetchFn; }
  private base() { return `${this.cfg.studio.baseUrl.replace(/\/+$/, '')}/api/v1`; }
  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    let r: Response;
    try { r = await this.fetchFn(this.base() + path, { ...init, headers: { 'x-api-key': this.key, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) }); }
    catch (e) { throw new MuapiError(`network: ${scrub((e as Error).message, this.key)}`); }
    const txt = await r.text(); let j: Record<string, unknown> = {}; try { j = JSON.parse(txt) as Record<string, unknown>; } catch { /* non-JSON error page */ }
    if (!r.ok) { const d = j.detail ?? j.error ?? j.message ?? txt; throw new MuapiError(`Muapi ${r.status}: ${scrub(typeof d === 'string' ? d : JSON.stringify(d), this.key)}${r.status === 401 || r.status === 403 ? ' (API key rejected: check it in Settings)' : r.status === 402 ? ' (not enough Muapi credits)' : ''}`, r.status); }
    return j;
  }
  /** Submit a generation. Returns the request id (the only thing needed to resume; never resubmit without checking it - jobs are billed). */
  async submit(endpoint: string, body: Record<string, unknown>): Promise<string> {
    const j = await this.call(`/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const id = String(j.request_id ?? j.id ?? ''); if (!SAFE_ID.test(id)) throw new MuapiError('Muapi did not return a request id'); return id;
  }
  async result(id: string): Promise<PredResult> {
    if (!SAFE_ID.test(id)) throw new MuapiError('bad request id');
    const j = await this.call(`/predictions/${id}/result`, { timeoutMs: 30_000 });
    const out = j.outputs; const outputs = Array.isArray(out) ? out.filter((x): x is string => typeof x === 'string') : typeof out === 'string' ? [out] : [];
    return { status: String(j.status ?? 'unknown').toLowerCase(), outputs, error: j.error ? scrub(String(j.error), this.key) : undefined, cost: j.cost };
  }
  /** Upload a local file so models can read it by URL. Returns the hosted URL. */
  async upload(name: string, mime: string, data: Buffer): Promise<string> {
    const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
    const j = await this.call('/upload_file', { method: 'POST', body: fd, timeoutMs: 5 * 60_000 });
    const u = String(j.url ?? (j.data as { url?: string } | undefined)?.url ?? ''); if (!/^https:\/\//.test(u)) throw new MuapiError('Muapi upload did not return a URL'); return u;
  }
}
