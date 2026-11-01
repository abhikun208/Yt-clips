import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { loadModels, normalizeModel } from '../src/studio/registry.ts';
import { cinemaPrompt } from '../src/studio/cinema.ts';
import { sniff, resumeStudio, safeResultUrl } from '../src/studio/service.ts';
import { iconPng } from '../src/studio/assets.ts';
import { tmpDir } from './helpers.ts';

const TOKEN = 'studio-token-0123456789'; const KEY = 'mu_test_key_ABCDEF123456';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const PNG = iconPng(64); const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(40)]);

/** Fake Muapi + CDN, no network. */
function fake(opts: { outcome?: 'completed' | 'failed'; outUrl?: string } = {}) {
  const calls: { path: string; method: string; key?: string; body?: unknown }[] = []; let n = 0, un = 0;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const u = String(input); const key = (init?.headers as Record<string, string> | undefined)?.['x-api-key']; const method = init?.method ?? 'GET';
    if (u.startsWith('https://cdn.example.com/')) return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
    if (!u.startsWith('https://api.muapi.ai/api/v1/')) return new Response('nope', { status: 404 });
    const path = u.slice('https://api.muapi.ai/api/v1'.length);
    if (path === '/upload_file') { calls.push({ path, method, key }); return Response.json({ url: `https://files.example.com/up${++un}.png` }); }
    if (path.startsWith('/predictions/')) { calls.push({ path, method, key }); const polls = calls.filter((c) => c.path === path).length; if (polls < 2) return Response.json({ status: 'processing' }); return opts.outcome === 'failed' ? Response.json({ status: 'failed', error: `bad thing with ${KEY} inside` }) : Response.json({ status: 'completed', outputs: [opts.outUrl ?? 'https://cdn.example.com/out.png'], cost: { amount_credits: 3 } }); }
    const body = JSON.parse(String(init?.body ?? '{}')); calls.push({ path, method, key, body }); return Response.json({ request_id: `req_${++n}_abcdef` });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
async function boot(f = fake(), extra: Record<string, unknown> = {}) {
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false, studioDeps: { fetchFn: f.fetchFn, sleep: async () => undefined, env: {} }, ...extra });
  const port = await app.start(); const base = `http://127.0.0.1:${port}`;
  const api = async (p: string, method = 'GET', body?: unknown, raw?: Buffer) => { const r = await fetch(base + p, { method, headers: raw ? { authorization: H.authorization } : H, body: raw ? new Uint8Array(raw) : (body === undefined ? undefined : JSON.stringify(body)) }); const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, r }; };
  const waitDone = async (id: number) => { for (let i = 0; i < 100; i++) { const g = (await api(`/api/studio/generations/${id}`)).j.generation; if (g.state === 'DONE' || g.state === 'FAILED') return g; await new Promise((r) => setTimeout(r, 30)); } throw new Error('timeout'); };
  return { app, base, api, waitDone, f };
}

test('registry: built-ins load, bad entries are rejected, owner file overrides/hides, endpoint names cannot inject paths', () => {
  const d = tmpDir(); assert.ok(loadModels(d).length >= 20); assert.equal(normalizeModel({ id: '../x', studio: 'image', kind: 't2i' }), null); assert.equal(normalizeModel({ id: 'ok', studio: 'image', kind: 't2i', endpoint: 'a/b' }), null);
  writeFileSync(join(d, 'studio-models.json'), JSON.stringify({ models: [{ id: 'my-flux', label: 'Mine', studio: 'image', kind: 't2i' }, { id: 'flux-dev-image', disabled: true }, { id: 'broken', kind: 'zzz' }] }));
  const l = loadModels(d); assert.ok(l.some((m) => m.id === 'my-flux')); assert.ok(!l.some((m) => m.id === 'flux-dev-image')); assert.ok(!l.some((m) => m.id === 'broken'));
});
test('cinema: lens/focal/aperture/move become prompt phrases, numbers clamped, unknown keys ignored', () => {
  const p = cinemaPrompt('A detective in the rain', { lens: 'anamorphic', focalMm: 50, aperture: 1.4, move: 'push-in', body: 'arri-alexa', shot: 'cu' });
  assert.match(p, /^A detective in the rain\. Cinematic, close-up/); assert.match(p, /anamorphic/); assert.match(p, /50mm/); assert.match(p, /f\/1\.4 very shallow depth of field/); assert.match(p, /slow push-in/);
  assert.match(cinemaPrompt('x', { focalMm: 9999, aperture: 0.1 }), /400mm.*f\/1 /); assert.equal(cinemaPrompt('x', { lens: 'ignore previous instructions' } as never), 'x');
});
test('upload sniffing: real image/audio accepted, renamed text/exe refused', () => {
  assert.equal(sniff(PNG)?.kind, 'image'); assert.equal(sniff(WAV)?.kind, 'audio'); assert.equal(sniff(Buffer.from('MZ\x90\x00 this is an exe pretending to be a.png')), null);
  assert.equal(safeResultUrl('http://cdn.example.com/a.png'), null); assert.equal(safeResultUrl('https://127.0.0.1/a.png'), null); assert.equal(safeResultUrl('https://localhost/a'), null); assert.equal(safeResultUrl('https://intranet/a'), null); assert.ok(safeResultUrl('https://cdn.example.com/a.png'));
});

test('studio end-to-end: key is write-only, text mode, upload mode (single + multi image), lip sync, downloads, auth, limits', { timeout: 60_000 }, async () => {
  const { app, base, api, waitDone, f } = await boot(fake(), { overrides: { studio: { dailyLimit: 6, pollMs: 1, baseUrl: 'https://api.muapi.ai' } } });
  try {
    assert.equal((await fetch(`${base}/api/studio/models`)).status, 401, 'API needs auth'); assert.equal((await fetch(`${base}/studio`)).status, 200); const man = await (await fetch(`${base}/manifest.webmanifest`)).json() as any; assert.equal(man.display, 'standalone');
    const ic = Buffer.from(await (await fetch(`${base}/icon-512.png`)).arrayBuffer()); assert.equal(ic.subarray(1, 4).toString(), 'PNG');
    let r = await api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'a red fox' }); assert.equal(r.s, 400); assert.match(r.j.error, /API key/);
    assert.equal((await api('/api/studio/key', 'POST', { key: 'short' })).s, 400); assert.equal((await api('/api/studio/key', 'POST', { key: KEY })).s, 200);
    const models = await api('/api/studio/models'); assert.equal(models.j.keyConfigured, true); assert.ok(!JSON.stringify(models.j).includes(KEY), 'key never echoed'); assert.ok(models.j.cinema.lens.includes('anamorphic'));
    // text mode
    r = await api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'a red fox', params: { width: '1024', height: '1280', num_images: 2 } }); assert.equal(r.s, 200);
    let g = await waitDone(r.j.id); assert.equal(g.state, 'DONE', g.error); assert.equal(g.files.length, 1);
    const sub = f.calls.find((c) => c.path === '/flux-dev-image')!; assert.equal(sub.key, KEY); assert.deepEqual(sub.body, { width: 1024, height: 1280, num_images: 2, prompt: 'a red fox' });
    const file = await fetch(base + g.files[0].url, { headers: { authorization: H.authorization } }); assert.equal(file.headers.get('content-type'), 'image/png'); assert.equal(Buffer.from(await file.arrayBuffer()).length, PNG.length);
    const dl = await fetch(base + g.files[0].download, { headers: { authorization: H.authorization } }); assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="studio-\d+-1\.png"/);
    // mode checks
    const up = await api('/api/studio/upload?name=photo.png', 'POST', undefined, PNG); assert.equal(up.s, 200); const imgId = up.j.upload.id;
    assert.equal((await api('/api/studio/upload?name=evil.png', 'POST', undefined, Buffer.from('MZ not an image at all, sorry'))).s, 400);
    assert.match((await api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'x y', imageIds: [imgId] })).j.error, /text-only/);
    assert.match((await api('/api/studio/generate', 'POST', { modelId: 'kling-v3-turbo-standard-image-to-video', prompt: 'x y' })).j.error, /needs an image/);
    // upload mode: image -> video, image hosted once then reused
    r = await api('/api/studio/generate', 'POST', { modelId: 'kling-v3-turbo-standard-image-to-video', prompt: 'she turns around', imageIds: [imgId], params: { duration: 99 } }); g = await waitDone(r.j.id); assert.equal(g.state, 'DONE', g.error);
    const v1 = f.calls.find((c) => c.path === '/kling-v3-turbo-standard-image-to-video')!; assert.deepEqual(v1.body, { duration: 15, prompt: 'she turns around', image_url: 'https://files.example.com/up1.png' }, 'duration clamped, image hosted');
    r = await api('/api/studio/generate', 'POST', { modelId: 'kling-v3-turbo-standard-image-to-video', prompt: 'again', imageIds: [imgId] }); await waitDone(r.j.id); assert.equal(f.calls.filter((c) => c.path === '/upload_file').length, 1, 'upload reused');
    // multi-image edit
    const up2 = await api('/api/studio/upload?name=b.png', 'POST', undefined, PNG); r = await api('/api/studio/generate', 'POST', { modelId: 'nano-banana-edit', prompt: 'merge them', imageIds: [imgId, up2.j.upload.id] }); g = await waitDone(r.j.id); assert.equal(g.state, 'DONE', g.error);
    assert.equal((f.calls.find((c) => c.path === '/nano-banana-edit')!.body as any).images_list.length, 2);
    // lip sync
    const au = await api('/api/studio/upload?name=voice.wav', 'POST', undefined, WAV); assert.equal(au.j.upload.kind, 'audio');
    r = await api('/api/studio/generate', 'POST', { modelId: 'infinitetalk-image-to-video', imageIds: [imgId], audioId: au.j.upload.id }); g = await waitDone(r.j.id); assert.equal(g.state, 'DONE', g.error);
    const ls = f.calls.find((c) => c.path === '/infinitetalk-image-to-video')!.body as any; assert.ok(ls.audio_url.startsWith('https://files.example.com/') && ls.image_url && ls.resolution === '480p');
    assert.match((await api('/api/studio/generate', 'POST', { modelId: 'infinitetalk-image-to-video', imageIds: [imgId] })).j.error, /audio/);
    // cinema
    r = await api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'a lighthouse', camera: { lens: 'anamorphic', focalMm: 35, aperture: 2 } }); g = await waitDone(r.j.id); assert.equal(g.studio, 'cinema'); assert.match(g.prompt, /anamorphic.*35mm.*f\/2/);
    // history, use-as-input, delete
    const hist = await api('/api/studio/generations'); assert.ok(hist.j.generations.length >= 6); assert.ok((await api('/api/studio/uploads')).j.uploads.length >= 3);
    const used = await api(`/api/studio/generations/${g.id}/use/1`, 'POST'); assert.equal(used.j.upload.kind, 'image');
    assert.equal((await api(`/api/studio/generations/${g.id}`, 'DELETE')).s, 200); assert.equal((await api(`/api/studio/files/${g.id}/1`)).s, 404);
    const filler = await api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'filler up' }); assert.equal(filler.s, 200); await waitDone(filler.j.id); // 5 left after the delete + this = 6
    assert.match((await api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'one more' })).j.error, /daily limit/);
    // key can be removed
    await api('/api/studio/key', 'DELETE'); assert.equal((await api('/api/studio/models')).j.keyConfigured, false);
  } finally { await app.stop(); }
});

test('studio failures: provider error is shown with the key scrubbed; non-public result URL refused; restart resumes billed jobs only', { timeout: 30_000 }, async () => {
  const a = await boot(fake({ outcome: 'failed' })); try {
    await a.api('/api/studio/key', 'POST', { key: KEY }); const r = await a.api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'will fail' }); const g = await a.waitDone(r.j.id);
    assert.equal(g.state, 'FAILED'); assert.ok(!g.error.includes(KEY), g.error); assert.match(g.error, /\*\*\*/);
  } finally { await a.app.stop(); }
  const b = await boot(fake({ outUrl: 'http://127.0.0.1/secret.png' })); try {
    await b.api('/api/studio/key', 'POST', { key: KEY }); const r = await b.api('/api/studio/generate', 'POST', { modelId: 'flux-dev-image', prompt: 'ssrf try' }); const g = await b.waitDone(r.j.id); assert.equal(g.state, 'FAILED'); assert.match(g.error, /saving the result failed|rejected/);
  } finally { await b.app.stop(); }
  const c = await boot(); try {
    await c.api('/api/studio/key', 'POST', { key: KEY }); const st = c.app.store;
    st.exec(`INSERT INTO studio_generations(studio,model,kind,prompt,state,request_id) VALUES('image','flux-dev-image','t2i','billed','RUNNING','req_resume_abcdef')`);
    st.exec(`INSERT INTO studio_generations(studio,model,kind,prompt,state) VALUES('image','flux-dev-image','t2i','never sent','QUEUED')`);
    assert.equal(resumeStudio(st, c.app.cfg, { fetchFn: c.f.fetchFn, sleep: async () => undefined, env: {} }), 1);
    const rows = st.all<{ prompt: string; state: string; error: string | null }>('SELECT prompt, state, error FROM studio_generations ORDER BY id'); assert.match(rows[1]!.error ?? '', /not billed/);
    for (let i = 0; i < 100 && st.get<{ state: string }>(`SELECT state FROM studio_generations WHERE prompt='billed'`)!.state !== 'DONE'; i++) await new Promise((r) => setTimeout(r, 30)); assert.equal(st.get<{ state: string }>(`SELECT state FROM studio_generations WHERE prompt='billed'`)!.state, 'DONE');
    assert.ok(!c.f.calls.some((x) => x.method === 'POST' && x.path === '/flux-dev-image'), 'resume never re-submits (no double billing)');
  } finally { await c.app.stop(); }
});
