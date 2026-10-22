import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import type { Store } from '../db.ts';
import type { Adapter } from './machine.ts';
import type { TokenProvider } from './oauth.ts';
import { warn } from '../util/log.ts';

const API = () => process.env.YT_API_BASE ?? 'https://www.googleapis.com';
/** Costs per Google's quota page (fetched 2026-10-22): videos.insert has its own 100/day cap (1 each); other calls draw on 10,000 units/day. Verify if Google changes them. */
export const QUOTA = { insert: { pool: 'insert', cost: 1 }, update: { pool: 'units', cost: 50 }, list: { pool: 'units', cost: 1 }, thumbnail: { pool: 'units', cost: 50 } } as const;
export interface YtOptions { chunkBytes?: number; dailyUnits?: number; dailyInserts?: number; maxRetries?: number; sleep?: (ms: number) => Promise<void>; now?: () => Date; categoryId?: string; notReadyTimeoutMs?: number }

/** Quota day boundary = midnight America/Los_Angeles (Google resets quota in Pacific Time). */
export const quotaDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export class YouTubeAdapter implements Adapter {
  readonly name = 'youtube';
  private o: Required<Omit<YtOptions, 'categoryId'>> & { categoryId: string };
  private store: Store; private tokens: TokenProvider;
  constructor(store: Store, tokens: TokenProvider, o: YtOptions = {}) {
    this.store = store; this.tokens = tokens;
    this.o = { chunkBytes: o.chunkBytes ?? 8 * 1024 * 1024, dailyUnits: o.dailyUnits ?? 10_000, dailyInserts: o.dailyInserts ?? 100, maxRetries: o.maxRetries ?? 5,
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now: o.now ?? (() => new Date()), categoryId: o.categoryId ?? '22', notReadyTimeoutMs: o.notReadyTimeoutMs ?? 6 * 3600_000 };
    if (this.o.chunkBytes % (256 * 1024) !== 0) throw new Error('chunkBytes must be a multiple of 256KiB');
  }

  // ---- quota ----
  quotaUsed(pool: 'units' | 'insert'): number { return this.store.get<{ units: number }>('SELECT units FROM quota_usage WHERE day=? AND pool=?', quotaDay(this.o.now()), pool)?.units ?? 0; }
  private charge(k: keyof typeof QUOTA): void {
    const q = QUOTA[k]; const cap = q.pool === 'insert' ? this.o.dailyInserts : this.o.dailyUnits; const used = this.quotaUsed(q.pool);
    if (used + q.cost > cap) throw new Error(`QUOTA_EXCEEDED: ${q.pool} ${used}+${q.cost} > ${cap} today (resets midnight Pacific)`);
    this.store.exec('INSERT INTO quota_usage(day, pool, units) VALUES (?,?,?) ON CONFLICT(day, pool) DO UPDATE SET units=units+excluded.units', quotaDay(this.o.now()), q.pool, q.cost);
  }

  // ---- http ----
  private async req(url: string, init: RequestInit & { retry?: boolean } = {}): Promise<Response> {
    let last: unknown;
    for (let a = 0; a <= (init.retry === false ? 0 : this.o.maxRetries); a++) {
      try {
        const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${await this.tokens.accessToken()}`, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(10 * 60_000) });
        if (r.status === 401 && a === 0) { continue; }
        if ([500, 502, 503, 504].includes(r.status) && a < this.o.maxRetries && init.retry !== false) { await this.o.sleep(Math.min(30_000, 500 * 2 ** a)); continue; }
        return r;
      } catch (e) { if (String((e as Error).message).startsWith('AUTH_')) throw e; last = e; if (a < this.o.maxRetries && init.retry !== false) await this.o.sleep(Math.min(30_000, 500 * 2 ** a)); }
    }
    throw new Error(`network error: ${(last as Error | undefined)?.message ?? 'unknown'}`);
  }
  private async apiError(r: Response, what: string): Promise<Error> {
    const t = await r.text().catch(() => ''); let reason = ''; try { const j = JSON.parse(t); reason = j.error?.errors?.[0]?.reason ?? j.error?.message ?? ''; } catch { /* not json */ }
    if (r.status === 403 && /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(reason + t)) return new Error(`QUOTA_EXCEEDED: ${what}: ${reason}`);
    if (r.status === 401) return new Error(`AUTH_REVOKED: ${what}: unauthorized`);
    return new Error(`${what} failed: HTTP ${r.status} ${reason}`.trim());
  }

  async whoami(): Promise<{ id: string; title: string } | null> {
    this.charge('list'); const r = await this.req(`${API()}/youtube/v3/channels?part=snippet&mine=true`); if (!r.ok) throw await this.apiError(r, 'channels.list');
    const j = await r.json() as { items?: { id: string; snippet: { title: string } }[] }; const c = j.items?.[0]; return c ? { id: c.id, title: c.snippet.title } : null;
  }

  // ---- upload (resumable, crash-safe) ----
  async upload(a: Parameters<Adapter['upload']>[0]): Promise<{ remoteId: string }> {
    const row = this.store.get<{ session_uri: string | null; total: number | null; remote_id: string | null }>('SELECT session_uri, total, remote_id FROM upload_sessions WHERE key=?', a.idempotencyKey);
    if (row?.remote_id) return { remoteId: row.remote_id }; // already uploaded: never duplicate
    const total = statSync(a.filePath).size; if (total <= 0) throw new Error('empty file');
    let session = row?.session_uri && row.total === total ? row.session_uri : null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!session) {
        this.charge('insert');
        const body = { snippet: { title: a.title, description: a.description, tags: a.tags, categoryId: a.categoryId ?? this.o.categoryId, ...(a.language ? { defaultLanguage: a.language, defaultAudioLanguage: a.language } : {}) }, status: { privacyStatus: a.visibility, selfDeclaredMadeForKids: false } };
        const init = await this.req(`${API()}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(total), 'x-upload-content-type': 'video/mp4' }, body: JSON.stringify(body) });
        if (!init.ok) throw await this.apiError(init, 'videos.insert (init)');
        session = init.headers.get('location'); if (!session) throw new Error('videos.insert: no Location header');
        this.store.exec('INSERT INTO upload_sessions(key, session_uri, total) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET session_uri=excluded.session_uri, total=excluded.total, updated_at=datetime(\'now\')', a.idempotencyKey, session, total);
      }
      const r = await this.sendAll(session, a.filePath, total);
      if (r === 'expired') { this.store.exec('UPDATE upload_sessions SET session_uri=NULL WHERE key=?', a.idempotencyKey); session = null; continue; }
      this.store.exec('UPDATE upload_sessions SET remote_id=?, updated_at=datetime(\'now\') WHERE key=?', r, a.idempotencyKey); // persisted immediately => restart-safe
      return { remoteId: r };
    }
    throw new Error('upload session expired twice');
  }

  private async offset(session: string, total: number): Promise<number | { done: string } | 'expired'> {
    const r = await this.req(session, { method: 'PUT', headers: { 'content-range': `bytes */${total}`, 'content-length': '0' }, retry: true });
    if (r.status === 404) return 'expired';
    if (r.status === 200 || r.status === 201) return { done: ((await r.json()) as { id: string }).id };
    if (r.status === 308) { const m = /bytes=0-(\d+)/.exec(r.headers.get('range') ?? ''); return m ? Number(m[1]) + 1 : 0; }
    throw await this.apiError(r, 'resumable status');
  }

  private async sendAll(session: string, file: string, total: number): Promise<string | 'expired'> {
    const fd = openSync(file, 'r');
    try {
      let off = await this.offset(session, total); if (off === 'expired') return 'expired'; if (typeof off === 'object') return off.done;
      let failures = 0;
      while (off < total) {
        const len = Math.min(this.o.chunkBytes, total - off); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, off);
        let r: Response | null = null;
        try { r = await this.req(session, { method: 'PUT', headers: { 'content-range': `bytes ${off}-${off + len - 1}/${total}`, 'content-type': 'video/mp4' }, body: buf, retry: false }); } catch { r = null; }
        if (r && (r.status === 200 || r.status === 201)) return ((await r.json()) as { id: string }).id;
        if (r && r.status === 308) { const m = /bytes=0-(\d+)/.exec(r.headers.get('range') ?? ''); off = m ? Number(m[1]) + 1 : off; failures = 0; continue; }
        if (r && r.status === 404) return 'expired';
        if (r && ![500, 502, 503, 504].includes(r.status)) throw await this.apiError(r, 'upload chunk');
        if (++failures > this.o.maxRetries) throw new Error(`upload chunk failed ${failures}x (HTTP ${r?.status ?? 'network'})`);
        await this.o.sleep(Math.min(30_000, 500 * 2 ** failures)); // don't assume the last chunk was or wasn't received: ask the server
        const o2 = await this.offset(session, total); if (o2 === 'expired') return 'expired'; if (typeof o2 === 'object') return o2.done; off = o2;
      }
      const fin = await this.offset(session, total); if (typeof fin === 'object') return fin.done;
      throw new Error('upload finished without a final response');
    } finally { closeSync(fd); }
  }

  // ---- verify / thumbnail / publish ----
  private async getVideo(id: string, parts: string): Promise<any | null> {
    this.charge('list'); const r = await this.req(`${API()}/youtube/v3/videos?part=${encodeURIComponent(parts)}&id=${encodeURIComponent(id)}`);
    if (!r.ok) throw await this.apiError(r, 'videos.list'); return ((await r.json()) as { items?: any[] }).items?.[0] ?? null;
  }
  async verify(id: string, expect?: { title: string; visibility: string }): Promise<{ processed: boolean; metadataMatches: boolean; visibility: string }> {
    const v = await this.getVideo(id, 'snippet,status,processingDetails'); if (!v) throw new Error(`remote video ${id} not found`);
    const st = v.status?.uploadStatus as string | undefined;
    if (st === 'failed' || st === 'rejected' || st === 'deleted') throw new Error(`remote upload ${st}: ${v.status?.failureReason ?? v.status?.rejectionReason ?? ''}`.trim());
    const ps = v.processingDetails?.processingStatus as string | undefined;
    if (st !== 'processed' || ps === 'processing') throw new Error(`NOT_READY: uploadStatus=${st} processing=${ps ?? 'n/a'}`);
    const visibility = v.status?.privacyStatus as string;
    return { processed: true, visibility, metadataMatches: !expect || (v.snippet?.title === expect.title && visibility === expect.visibility) };
  }
  async thumbnail(id: string, path: string): Promise<boolean> {
    try {
      this.charge('thumbnail'); const r = await this.req(`${API()}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: readFileSync(path), retry: false });
      if (!r.ok) { warn('thumbnail rejected', { status: r.status }); return false; } return true;
    } catch (e) { if (/^(QUOTA|AUTH)_/.test((e as Error).message)) throw e; warn('thumbnail failed', { err: (e as Error).message.slice(0, 120) }); return false; }
  }
  /** at=null -> public now; at=Date -> private + publishAt (YouTube auto-publishes). Merges current writable status fields first because omitted fields are reset (per videos.update docs). */
  async publish(id: string, at: Date | null): Promise<void> {
    const cur = await this.getVideo(id, 'status'); if (!cur) throw new Error(`remote video ${id} not found`);
    const keep: Record<string, unknown> = {}; for (const k of ['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia']) if (cur.status?.[k] !== undefined) keep[k] = cur.status[k];
    const status = at ? { ...keep, privacyStatus: 'private', publishAt: at.toISOString() } : { ...keep, privacyStatus: 'public' };
    this.charge('update'); const r = await this.req(`${API()}/youtube/v3/videos?part=status`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status }), retry: false });
    if (!r.ok) throw await this.apiError(r, 'videos.update');
  }
}
