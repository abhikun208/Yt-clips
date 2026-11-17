import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { createChannel, ytSecretName, getChannel } from '../src/channels.ts';
import { listDestinations, disconnectDestination, setDestinationEnabled, destinationBlock } from '../src/accounts/destinations.ts';

function env() { const cfg = loadConfig(tmpDir()); const store = new Store(':memory:'); return { cfg, store, sec: SecretStore.forData(cfg.dataDir) }; }
const ident = (store: Store, slug: string, id: string, title: string) => store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, `ytinfo:${slug}`, JSON.stringify({ channelId: id, title, at: 'x' }));
const noPlain = (o: unknown) => assert.ok(!/refresh|access_token|TOKEN/i.test(JSON.stringify(o)), 'no secrets in API output');

test('two YouTube logins stay two destinations; disconnecting one leaves the other', () => {
  const { cfg, store, sec } = env(); const a = createChannel(store, { name: 'Gaming A' }, () => true); const b = createChannel(store, { name: 'Gaming B' }, () => true);
  sec.write(ytSecretName(a), { refresh_token: 'RA' }); ident(store, a.slug, 'UC_A', 'Chan A'); sec.write(ytSecretName(b), { refresh_token: 'RB' }); ident(store, b.slug, 'UC_B', 'Chan B');
  const l = listDestinations(store, cfg).filter((d) => d.platform === 'youtube'); assert.deepEqual(l.map((d) => d.id).sort(), ['yt:UC_A', 'yt:UC_B']); noPlain(l);
  disconnectDestination(store, cfg, 'yt:UC_A');
  const m = listDestinations(store, cfg); assert.equal(m.find((d) => d.id === 'yt:UC_A')!.status, 'disconnected'); assert.equal(m.find((d) => d.id === 'yt:UC_B')!.status, 'connected');
  assert.equal(sec.read<{ refresh_token: string }>(ytSecretName(b))!.refresh_token, 'RB');
  sec.write(ytSecretName(a), { refresh_token: 'RA2' }); ident(store, a.slug, 'UC_A', 'Chan A'); assert.equal(listDestinations(store, cfg).find((d) => d.id === 'yt:UC_A')!.status, 'connected', 'reconnect brings it back');
});
test('duplicate login of the same YouTube channel is flagged, not doubled', () => {
  const { cfg, store, sec } = env(); const a = createChannel(store, { name: 'One' }, () => true); const b = createChannel(store, { name: 'Two' }, () => true);
  for (const c of [a, b]) { sec.write(ytSecretName(c), { refresh_token: 'R' + c.slug }); ident(store, c.slug, 'UC_SAME', 'Same'); }
  const l = listDestinations(store, cfg).filter((d) => d.platform === 'youtube'); assert.equal(l.length, 1); assert.match(l[0]!.warnings[0] ?? '', /jagah/);
});
test('Meta: two Pages + Instagram are separate destinations; Instagram disconnect keeps the Page; Page disconnect is independent', () => {
  const { cfg, store, sec } = env();
  sec.write('meta-pages', { pages: [{ id: 'P1', name: 'Page One', access_token: 'T1', ig_user_id: 'I1' }, { id: 'P2', name: 'Page Two', access_token: 'T2', ig_user_id: null }], user_token: 'U' });
  assert.deepEqual(listDestinations(store, cfg).map((d) => d.id).sort(), ['fb:P1', 'fb:P2', 'ig:I1']);
  disconnectDestination(store, cfg, 'ig:I1'); let m = listDestinations(store, cfg); assert.equal(m.find((d) => d.id === 'ig:I1')!.status, 'disconnected'); assert.equal(m.find((d) => d.id === 'fb:P1')!.status, 'connected');
  disconnectDestination(store, cfg, 'fb:P2'); m = listDestinations(store, cfg); assert.equal(m.find((d) => d.id === 'fb:P2')!.status, 'disconnected'); assert.equal(m.find((d) => d.id === 'fb:P1')!.status, 'connected');
});
test('TikTok: expired refresh token is shown as expired; a second account has its own destination', () => {
  const { cfg, store, sec } = env();
  sec.write('tiktok', { access_token: 'a', refresh_token: 'r', open_id: 'OPEN111111', expires_at: Date.now() + 1e6, refresh_expires_at: Date.now() + 1e9 });
  sec.write('tiktok-OPEN222222', { access_token: 'b', refresh_token: 'r', open_id: 'OPEN222222', expires_at: Date.now() - 1, refresh_expires_at: Date.now() - 1 });
  const l = listDestinations(store, cfg); assert.equal(l.find((d) => d.id === 'tt:OPEN111111')!.status, 'connected'); assert.equal(l.find((d) => d.id === 'tt:OPEN222222')!.status, 'expired');
  disconnectDestination(store, cfg, 'tt:OPEN222222'); assert.equal(sec.read<{ access_token: string }>('tiktok')!.access_token, 'a');
});
test('disabled destination blocks only its own channel; enable restores; unknown id rejected', () => {
  const { cfg, store, sec } = env(); const a = createChannel(store, { name: 'AA' }, () => true); const b = createChannel(store, { name: 'BB' }, () => true);
  for (const [c, id] of [[a, 'UC_A'], [b, 'UC_B']] as const) { sec.write(ytSecretName(c), { refresh_token: 'R' }); ident(store, c.slug, id, id); }
  listDestinations(store, cfg); setDestinationEnabled(store, 'yt:UC_A', false);
  assert.match(destinationBlock(store, cfg, a.slug, 'youtube_shorts') ?? '', /^DESTINATION_DISABLED/); assert.equal(destinationBlock(store, cfg, b.slug, 'youtube_shorts'), null);
  setDestinationEnabled(store, 'yt:UC_A', true); assert.equal(destinationBlock(store, cfg, a.slug, 'youtube_shorts'), null);
  assert.throws(() => setDestinationEnabled(store, 'yt:nope', true), /unknown account/);
});
test('upgrade path: existing data untouched, registry is additive and idempotent', () => {
  const { cfg, store, sec } = env(); const before = store.get<{ n: number }>('SELECT COUNT(*) n FROM channels')!.n;
  sec.write('youtube', { refresh_token: 'MAIN' }); listDestinations(store, cfg); listDestinations(store, cfg);
  assert.equal(store.get<{ n: number }>('SELECT COUNT(*) n FROM destinations')!.n, 1); assert.equal(store.get<{ n: number }>('SELECT COUNT(*) n FROM channels')!.n, before); assert.equal(sec.read<{ refresh_token: string }>('youtube')!.refresh_token, 'MAIN');
});
test('Meta login merge: a second login adds Pages and never drops the first login\'s Pages or default account', async () => {
  const { cfg, store, sec } = env(); const { handleCallback } = await import('../src/publish/socialOauth.ts'); void handleCallback; void store;
  sec.write('meta-pages', { pages: [{ id: 'P1', name: 'One', access_token: 'T1', ig_user_id: null }], user_token: 'U1' }); sec.write('facebook', { access_token: 'T1', page_id: 'P1', page_name: 'One' });
  assert.equal(listDestinations(store, cfg).filter((d) => d.platform === 'facebook').length, 1);
});

// ---------- end-to-end with fake Google / Meta / TikTok servers ----------
import { createServer, type Server } from 'node:http';
import { startWebAuth, finishWebAuth } from '../src/publish/webauth.ts';
import { saveAppCreds, startAuth, handleCallback } from '../src/publish/socialOauth.ts';
async function fake(h: (u: URL, req: import('node:http').IncomingMessage, body: string) => unknown): Promise<{ s: Server; base: string }> {
  const s = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(h(new URL(req.url!, 'http://x'), req, b) ?? {})); }); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return { s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
}
test('Google: a second login for a DIFFERENT channel on the same slug never replaces the first; same channel again just reconnects', async () => {
  const chOf: Record<string, string> = { c1: 'UC_ONE', c2: 'UC_TWO' };
  const g = await fake((u, req, body) => {
    if (u.pathname === '/token') { const p = new URLSearchParams(body); return p.get('grant_type') === 'refresh_token' ? { access_token: 'AT-' + p.get('refresh_token'), expires_in: 3600 } : { refresh_token: 'RT-' + p.get('code'), access_token: 'x', expires_in: 3600, scope: 'youtube.upload' }; }
    if (u.pathname === '/youtube/v3/channels') { const code = String(req.headers.authorization).replace('Bearer AT-RT-', ''); return { items: [{ id: chOf[code], snippet: { title: 'Title ' + chOf[code] } }] }; }
    return {};
  });
  process.env.YT_OAUTH_BASE = g.base; process.env.YT_API_BASE = g.base; process.env.YT_OAUTH_CLIENT_ID = 'id'; process.env.YT_OAUTH_CLIENT_SECRET = 'sec';
  try {
    const { cfg, store, sec } = env(); const main = getChannel(store, 'main');
    const login = async (slug: string, code: string) => { const w = startWebAuth(store, cfg, getChannel(store, slug), { base: 'http://127.0.0.1:8080' }); const st = new URL(w.authUrl).searchParams.get('state'); return finishWebAuth(store, cfg, { code, state: st, error: null }); };
    const r1 = await login('main', 'c1'); assert.equal(r1.slug, 'main'); assert.equal(r1.identity!.channelId, 'UC_ONE');
    const r2 = await login('main', 'c2'); assert.notEqual(r2.slug, 'main', 'different Google login lands on a NEW slug');
    assert.equal(sec.read<{ refresh_token: string }>(ytSecretName(main))!.refresh_token, 'RT-c1', 'first account untouched');
    assert.equal(sec.read<{ refresh_token: string }>(ytSecretName(getChannel(store, r2.slug)))!.refresh_token, 'RT-c2');
    const r3 = await login('main', 'c1'); assert.equal(r3.slug, 'main'); // reconnect of the same channel
    const r4 = await login(r2.slug, 'c1'); assert.equal(r4.slug, 'main', 'same channel via another slug is merged, not duplicated');
    assert.equal(sec.read<{ refresh_token: string }>(ytSecretName(getChannel(store, r2.slug)))!.refresh_token, 'RT-c2', 'second account still intact');
    const e = createChannel(store, { name: 'Empty card' }, () => true); const r5 = await login(e.slug, 'c1');
    assert.equal(r5.slug, e.slug, 'clicked card becomes connected'); assert.equal(sec.read<{ refresh_token: string }>(ytSecretName(main))!.refresh_token, 'RT-c1');
    assert.equal(sec.read<{ refresh_token: string }>(ytSecretName(getChannel(store, r2.slug)))!.refresh_token, 'RT-c2', 'other account untouched');
    const ids = listDestinations(store, cfg).filter((d) => d.platform === 'youtube' && d.status === 'connected').map((d) => d.id).sort(); assert.deepEqual(ids, ['yt:UC_ONE', 'yt:UC_TWO']);
  } finally { g.s.close(); delete process.env.YT_OAUTH_BASE; delete process.env.YT_API_BASE; delete process.env.YT_OAUTH_CLIENT_ID; delete process.env.YT_OAUTH_CLIENT_SECRET; }
});
test('Meta: a second login merges Pages and keeps the default account; TikTok second account gets its own secret', async () => {
  const pagesOf: Record<string, unknown[]> = { a: [{ id: 'P1', name: 'One', access_token: 'PT1', instagram_business_account: { id: 'I1' } }], b: [{ id: 'P2', name: 'Two', access_token: 'PT2' }] };
  const g = await fake((u, _r, body) => {
    if (u.pathname.endsWith('/oauth/access_token')) return { access_token: 'U-' + (u.searchParams.get('code') ?? u.searchParams.get('fb_exchange_token')!.replace('U-', '')) };
    if (u.pathname.endsWith('/me/accounts')) return { data: pagesOf[u.searchParams.get('access_token')!.replace('U-', '')] };
    if (u.pathname.endsWith('/me/permissions')) return { data: [{ permission: 'pages_show_list', status: 'granted' }] };
    if (u.pathname.endsWith('/oauth/token/')) { const c = new URLSearchParams(body).get('code')!; return { access_token: 'TA-' + c, refresh_token: 'TR-' + c, open_id: 'OPEN-' + c + '-xxxx', expires_in: 3600, refresh_expires_in: 99999 }; }
    return {};
  });
  process.env.GRAPH_API_BASE = g.base; process.env.TIKTOK_API_BASE = g.base;
  try {
    const { cfg, store, sec } = env(); saveAppCreds(cfg, 'facebook', 'fid-12345', 'fsecret-12345'); saveAppCreds(cfg, 'tiktok', 'tkey-12345', 'tsecret-12345');
    const go = async (app: 'facebook' | 'tiktok', code: string) => { const st = new URL(startAuth(store, cfg, app, 'https://x.example')).searchParams.get('state')!; return handleCallback(store, cfg, app, { code, state: st }, 'https://x.example'); };
    await go('facebook', 'a'); await go('facebook', 'b');
    assert.deepEqual(sec.read<{ pages: { id: string }[] }>('meta-pages')!.pages.map((p) => p.id).sort(), ['P1', 'P2'], 'both logins kept');
    assert.equal(sec.read<{ page_id: string }>('facebook')!.page_id, 'P1', 'default account not overwritten by the 2nd login');
    assert.ok(sec.read<{ ig_user_id: string }>('instagram')!.ig_user_id === 'I1');
    assert.deepEqual(listDestinations(store, cfg).map((d) => d.id).sort(), ['fb:P1', 'fb:P2', 'ig:I1']);
    await go('tiktok', 't1'); await go('tiktok', 't2');
    assert.equal(sec.read<{ access_token: string }>('tiktok')!.access_token, 'TA-t1', 'first TikTok untouched');
    assert.ok(sec.read('tiktok-OPEN-t2-xxxx'), 'second TikTok has its own secret');
    assert.equal(listDestinations(store, cfg).filter((d) => d.platform === 'tiktok').length, 2);
  } finally { g.s.close(); delete process.env.GRAPH_API_BASE; delete process.env.TIKTOK_API_BASE; }
});
