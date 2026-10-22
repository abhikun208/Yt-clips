import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface Req { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: Buffer }
export interface Fake {
  server: Server; base: string; log: Req[]; videos: Map<string, any>; sessions: Map<string, { total: number; got: Buffer; init: any }>;
  opts: { failChunkOnce: number | null; dropAfterStoreOnce: number | null; processedAfterPolls: number; thumbStatus: number; revoked: boolean; device: string[]; initStatus: number; expireSessionOnce: boolean; uploadStatusFinal: string; quotaOnList: boolean; commentScopeOk: boolean };
  chunkCount: number; polls: Record<string, number>; close(): Promise<void>;
}

export async function startFake(): Promise<Fake> {
  const f: Fake = { server: null as any, base: '', log: [], videos: new Map(), sessions: new Map(), chunkCount: 0, polls: {}, close: async () => {},
    opts: { failChunkOnce: null, dropAfterStoreOnce: null, processedAfterPolls: 0, thumbStatus: 200, revoked: false, device: ['pending', 'ok'], initStatus: 200, expireSessionOnce: false, uploadStatusFinal: 'processed', quotaOnList: false, commentScopeOk: true } };
  let n = 0;
  const send = (res: ServerResponse, code: number, body?: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  f.server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const body = Buffer.concat(chunks);
    const u = new URL(req.url!, 'http://x'); const r: Req = { method: req.method!, path: u.pathname, query: u.searchParams, headers: req.headers, body }; f.log.push(r);
    const form = () => new URLSearchParams(body.toString());
    // ---- OAuth ----
    if (u.pathname === '/device/code') return send(res, 200, { device_code: 'DEV123', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 1 });
    if (u.pathname === '/token') {
      const p = form();
      if (p.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') { const s = f.opts.device.shift() ?? 'ok'; return s === 'ok' ? send(res, 200, { access_token: 'at', refresh_token: 'REFRESH-TOKEN-XYZ', expires_in: 3600 }) : send(res, 428, { error: s === 'pending' ? 'authorization_pending' : s }); }
      if (p.get('grant_type') === 'refresh_token') { if (f.opts.revoked || p.get('refresh_token') !== 'REFRESH-TOKEN-XYZ') return send(res, 400, { error: 'invalid_grant' }); return send(res, 200, { access_token: `fake-access-${++n}`, expires_in: 3600 }); }
      if (p.get('grant_type') === 'authorization_code') { if (!p.get('code_verifier') || p.get('code') !== 'AUTHCODE' || !String(p.get('redirect_uri')).startsWith('http://127.0.0.1:')) return send(res, 400, { error: 'invalid_grant' }); return send(res, 200, { access_token: 'at', refresh_token: 'REFRESH-TOKEN-XYZ', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.force-ssl' }); }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    // ---- API (all need a bearer) ----
    if (!/^Bearer fake-access-/.test(String(req.headers.authorization ?? ''))) return send(res, 401, { error: { message: 'unauthorized' } });
    if (u.pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
      if (f.opts.initStatus !== 200) return send(res, f.opts.initStatus, { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } });
      const id = `sess${f.sessions.size + 1}`; f.sessions.set(id, { total: Number(req.headers['x-upload-content-length']), got: Buffer.alloc(0), init: JSON.parse(body.toString()) });
      return send(res, 200, undefined, { location: `${f.base}/upload/session/${id}`, 'content-length': '0' });
    }
    const sm = /^\/upload\/session\/(\w+)$/.exec(u.pathname);
    if (sm && req.method === 'PUT') {
      const s = f.sessions.get(sm[1]!); if (!s || f.opts.expireSessionOnce) { f.opts.expireSessionOnce = false; f.sessions.delete(sm[1]!); return send(res, 404, { error: 'gone' }); }
      const cr = String(req.headers['content-range'] ?? '');
      const finish = () => { const id = `vid_${sm[1]}`; if (!f.videos.has(id)) f.videos.set(id, { id, snippet: { title: s.init.snippet.title, description: s.init.snippet.description, tags: s.init.snippet.tags }, status: { uploadStatus: 'uploaded', privacyStatus: s.init.status.privacyStatus, selfDeclaredMadeForKids: false, embeddable: true, license: 'youtube', publicStatsViewable: true } }); return send(res, 201, f.videos.get(id)); };
      if (/^bytes \*\//.test(cr)) { if (s.got.length === s.total) return send(res, 200, f.videos.get(`vid_${sm[1]}`)); return send(res, 308, undefined, s.got.length ? { range: `bytes=0-${s.got.length - 1}` } : {}); }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr); if (!m) return send(res, 400, { error: 'bad range' });
      f.chunkCount++;
      if (f.opts.failChunkOnce === f.chunkCount) return send(res, 503, { error: 'try later' });
      if (Number(m[1]) !== s.got.length) return send(res, 400, { error: `gap/overlap: expected ${s.got.length} got ${m[1]}` });
      s.got = Buffer.concat([s.got, body]);
      if (f.opts.dropAfterStoreOnce === f.chunkCount) { req.socket.destroy(); return; }
      if (s.got.length === s.total) return finish();
      return send(res, 308, undefined, { range: `bytes=0-${s.got.length - 1}` });
    }
    if (u.pathname === '/youtube/v3/videos' && req.method === 'GET') {
      if (f.opts.quotaOnList) return send(res, 403, { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } });
      const idsq = u.searchParams.get('id')!.split(','); const items: any[] = [];
      for (const id of idsq) { const v = f.videos.get(id); if (!v) continue;
        f.polls[id] = (f.polls[id] ?? 0) + 1; const ready = f.polls[id]! > f.opts.processedAfterPolls;
        items.push({ ...v, snippet: { ...v.snippet, publishedAt: '2026-10-01T12:30:00Z' }, statistics: { viewCount: '1234', likeCount: '56', commentCount: '7' }, status: { ...v.status, uploadStatus: ready ? f.opts.uploadStatusFinal : 'uploaded' }, processingDetails: { processingStatus: ready ? 'succeeded' : 'processing' } }); }
      return send(res, 200, { items });
    }
    if (u.pathname === '/youtube/v3/videos' && req.method === 'PUT') { const b = JSON.parse(body.toString()); const v = f.videos.get(b.id); if (!v) return send(res, 404, { error: { message: 'videoNotFound' } }); v.status = { ...b.status, uploadStatus: v.status.uploadStatus }; v.updateBody = b; return send(res, 200, v); }
    if (u.pathname === '/upload/youtube/v3/thumbnails/set') return send(res, f.opts.thumbStatus, f.opts.thumbStatus === 200 ? { items: [{}] } : { error: { message: 'forbidden' } });
    if (u.pathname === '/youtube/v3/commentThreads') return send(res, 200, { items: [
      { snippet: { canReply: true, topLevelComment: { id: 'c1', snippet: { textOriginal: 'Ye kaise banaya?', authorDisplayName: 'A', authorChannelId: { value: 'UCviewer' } } } } },
      { snippet: { canReply: true, topLevelComment: { id: 'c2', snippet: { textOriginal: 'Great video', authorDisplayName: 'Me', authorChannelId: { value: 'UC123' } } } } },
      { snippet: { canReply: true, topLevelComment: { id: 'c3', snippet: { textOriginal: 'sub4sub http://spam.com', authorDisplayName: 'S', authorChannelId: { value: 'UCspam' } } } } },
      { snippet: { canReply: true, topLevelComment: { id: 'c4', snippet: { textOriginal: 'mast video bhai 🔥', authorDisplayName: 'B', authorChannelId: { value: 'UCb' } } } } }] });
    if (u.pathname === '/youtube/v3/comments' && req.method === 'POST') { if (!f.opts.commentScopeOk) return send(res, 403, { error: { errors: [{ reason: 'insufficientPermissions' }], message: 'Insufficient Permission' } }); const b = JSON.parse(body.toString()); (f as any).replies = [...((f as any).replies ?? []), b.snippet]; return send(res, 200, { id: 'reply1' }); }
    if (u.pathname === '/youtube/v3/channels') return send(res, 200, { items: [{ id: 'UC123', snippet: { title: 'My Channel' } }] });
    send(res, 404, { error: 'unknown' });
  });
  await new Promise<void>((ok) => f.server.listen(0, '127.0.0.1', ok));
  f.base = `http://127.0.0.1:${(f.server.address() as { port: number }).port}`;
  f.close = () => new Promise<void>((ok) => { f.server.closeAllConnections?.(); f.server.close(() => ok()); });
  return f;
}
