import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { reportLlm, orderChain, llmFetch, allProvidersDown, llmHealth, resetLlmHealth } from '../src/ai/health.ts';
import { ingestComment, llmDraftReplies } from '../src/comments/comments.ts';
import { llmMetadata } from '../src/seo/llm.ts';
import { buildMetadata } from '../src/seo/metadata.ts';
import { topTitleExamples } from '../src/seo/learning.ts';

const A = { baseUrl: 'http://a/v1', apiKey: 'key-aaaaaa', model: 'm' }, B = { baseUrl: 'http://b/v1', apiKey: 'key-bbbbbb', model: 'm' }, C = { baseUrl: 'http://c/v1', model: 'local' };

test('health registry: 429 => cool-down (Retry-After honoured, doubling), 401 => long back-off, success clears; cooling providers go LAST but are never dropped; all-down detected', () => {
  resetLlmHealth(); const t = 1_000_000;
  reportLlm(A, 'rate', { now: t, retryAfterSec: 30 }); assert.deepEqual(orderChain([A, B, C], t + 1000), [B, C, A]); assert.deepEqual(orderChain([A, B, C], t + 31_000), [A, B, C], 'cool-down over');
  reportLlm(B, 'auth', { now: t }); reportLlm(B, 'auth', { now: t }); assert.equal(llmHealth([B], t + 1000)[0]!.state, 'key-rejected'); assert.ok(llmHealth([B], t + 1000)[0]!.retryInSec > 3600, 'repeat strike doubles the back-off');
  reportLlm(C, 'down', { now: t }); assert.equal(allProvidersDown([A, B, C], t + 1000), true, 'A cooling, B rejected, C down'); assert.equal(allProvidersDown([A, B, C], t + 31_000), false, 'A cool-down (30 s) is over');
  reportLlm(A, 'rate', { now: t + 40_000 }); assert.equal(allProvidersDown([A, B, C], t + 41_000), true); assert.equal(orderChain([A, B, C], t + 41_000).length, 3, 'last resort: still all tried');
  reportLlm(B, 'ok', { now: t + 50_000 }); assert.equal(allProvidersDown([A, B, C], t + 50_001), false);
});

test('router in the real call path: a rate-limited provider is NOT called again while cooling - traffic goes straight to the healthy one; failure of one never reaches the owner', async () => {
  resetLlmHealth(); const calls: string[] = []; const store = new Store(':memory:');
  const f = (async (u: string) => { const host = new URL(u).host; calls.push(host); if (host === 'a') return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }); return new Response(JSON.stringify({ choices: [{ message: { content: 'Shukriya bhai, dil se!' } }] }), { status: 200 }); }) as unknown as typeof fetch;
  const chain = [{ baseUrl: 'http://a/v1', model: 'm' }, { baseUrl: 'http://b/v1', model: 'm' }];
  ingestComment(store, 'yt', 'c1', 'Zabardast video bhai mast'); ingestComment(store, 'yt', 'c2', 'Awesome love this video');
  await llmDraftReplies(store, chain, { fetchFn: f, max: 1 }); assert.deepEqual(calls, ['a', 'b'], 'first call: A rate-limited -> falls over to B in the same request');
  await llmDraftReplies(store, chain, { fetchFn: f, max: 1 }); assert.deepEqual(calls, ['a', 'b', 'b'], 'second call: A is cooling, B answers directly (no 429 hammering)');
});

test('llmFetch: 5xx/timeouts count against the provider, a 400 (our request) does not', async () => {
  resetLlmHealth(); const E = { baseUrl: 'http://z/v1', model: 'm' };
  await llmFetch((async () => new Response('bad', { status: 400 })) as unknown as typeof fetch, E, 'http://z/v1/x', {}); assert.equal(llmHealth([E])[0]!.state, 'healthy');
  await llmFetch((async () => new Response('err', { status: 503 })) as unknown as typeof fetch, E, 'http://z/v1/x', {}); assert.equal(llmHealth([E])[0]!.state, 'down');
  await assert.rejects(llmFetch((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch, { ...E, model: 'n' }, 'http://z/v1/x', {}));
  assert.equal(llmHealth([{ ...E, model: 'n' }])[0]!.state, 'down');
});

test('learning loop: the channel\'s measured winners reach the title prompt as style examples (only with real evidence)', async () => {
  const store = new Store(':memory:'); const now = Date.parse('2026-11-05T00:00:00Z'); const chId = store.get<{ id: number }>(`SELECT id FROM channels WHERE slug='main'`)!.id; store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'v','f')`);
  const titles = ['Rohit ka century 😱 kya khela', 'Chai recipe jo sab bhool jate hain', 'Budget 2027 me kya sasta hua?', 'Aaj ka din kaisa raha', 'Phone ki battery bachane ke 3 tareeke', 'Ghar ki safai ka asaan jugaad', 'Monsoon trip ka plan'];
  const views = [90_000, 4_000, 3_500, 3_000, 2_500, 2_000, 1_500];
  titles.forEach((t, i) => { store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, category, fingerprint) VALUES (?,1,0,9,0.9,'g',?)`, i + 1, 'fp' + i); store.exec(`INSERT INTO clips(id, candidate_id, output_id, variant, metadata_json, state) VALUES (?,?,?,0,?, 'QC_PASSED')`, i + 1, i + 1, 'o' + i, JSON.stringify({ title: t + ' #Shorts' }));
    store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, remote_id, channel_id) VALUES (?, 'youtube_shorts','PUBLISHED',?,?,?)`, i + 1, 'k' + i, 'r' + i, chId); store.exec(`INSERT INTO analytics_snapshots(platform, remote_id, published_at, views) VALUES ('youtube_shorts', ?, '2026-10-20T00:00:00Z', ?)`, 'r' + i, views[i]); });
  assert.deepEqual(topTitleExamples(store, chId, chId, { now }), ['Rohit ka century 😱 kya khela'], 'only a clear winner (>= 1.5x median) is used, "#Shorts" stripped');
  assert.deepEqual(topTitleExamples(store, chId, chId, { now, min: 20 }), [], 'too little evidence => nothing is injected');
  const bodies: string[] = []; const f = (async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body).messages[0].content); return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"x yz title here"}' } }] }), { status: 200 }); }) as unknown as typeof fetch;
  await llmMetadata(buildMetadata({ transcript: 'Rohit ne century maari', category: 'sports', language: 'en' } as never), 'Rohit ne century maari', { baseUrl: 'http://q/v1', apiKey: '', model: 'm' }, f, [], ['Rohit ka century 😱 kya khela']);
  assert.match(bodies[0]!, /best-performing past titles.*Rohit ka century.*ONLY as a style reference/s);
});

test('semantic learning: one cached LLM call turns the winners into a "what they share" insight that reaches the title prompt; recomputed only when winners change', async () => {
  const { hookInsight } = await import('../src/seo/learning.ts'); resetLlmHealth(); const store = new Store(':memory:'); let calls = 0;
  const f = (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'They open with a question about a named person and end with a reaction emoji.' } }] }), { status: 200 }); }) as unknown as typeof fetch;
  const chain = [{ baseUrl: 'http://h/v1', model: 'm' }]; const ex = ['Rohit ka century kaise?', 'Dhoni ne kya kiya? 😱'];
  assert.match((await hookInsight(store, 1, ex, chain, f))!, /question about a named person/); await hookInsight(store, 1, ex, chain, f); assert.equal(calls, 1, 'cached');
  await hookInsight(store, 1, [...ex, 'Kohli ne ye kya kiya?'], chain, f); assert.equal(calls, 2, 'winners changed => recomputed'); assert.equal(await hookInsight(store, 1, ['only one'], chain, f), null);
  const bodies: string[] = []; const g = (async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body).messages[0].content); return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"abc def title"}' } }] }), { status: 200 }); }) as unknown as typeof fetch;
  await llmMetadata(buildMetadata({ transcript: 'x', category: 'g', language: 'en' } as never), 'x', { baseUrl: 'http://q/v1', apiKey: '', model: 'm' }, g, [], ex, 'They open with a question.'); assert.match(bodies[0]!, /What they share: They open with a question/);
});

test('transparency: each clip records which AI wrote its metadata (host · model) or "rules" when none answered', async () => {
  const { metaForClip } = await import('../src/seo/clipmeta.ts'); const { loadConfig } = await import('../src/config.ts'); const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dataDir = mkdtempSync(join(tmpdir(), 'gb-')); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(':memory:');
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x/a.mp4','f')`);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint, transcript, language) VALUES (1,1,0,20,.5,'c','aaj main aapko batata hoon ki paisa kaise bachaya jata hai bahut aasan tarika hai dekho','hi')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1','/nonexistent.mp4',1)`);
  const md = await metaForClip(store, cfg, 1, { notifyOwner: false });
  assert.equal(md.generatedBy, 'rules (no AI answered)');
  assert.equal((JSON.parse(store.get<{ metadata_json: string }>('SELECT metadata_json FROM clips WHERE id=1')!.metadata_json) as { generatedBy: string }).generatedBy, 'rules (no AI answered)');
});

test('exploration: with winners in the prompt, the model is told to break the pattern in one alternative', async () => {
  let prompt = ''; const f = (async (_u: string, init: { body: string }) => { prompt = JSON.parse(init.body).messages.map((m: { content: string }) => m.content).join('\n'); return new Response('{}', { status: 500 }); }) as unknown as typeof fetch;
  const base = buildMetadata({ transcript: 'aaj ka match bahut zabardast tha dekho kya hua', category: 'sports', language: 'hi', clipStart: 0, duration: 20 } as never);
  await llmMetadata(base, 'aaj ka match bahut zabardast tha dekho kya hua', { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }, f, [], ['Winner one', 'Winner two'], 'short questions');
  assert.match(prompt, /deliberately DIFFERENT/); assert.match(prompt, /What they share: short questions/);
  prompt = ''; await llmMetadata(base, 'aaj ka match bahut zabardast tha dekho kya hua', { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }, f, [], [], null);
  assert.doesNotMatch(prompt, /deliberately DIFFERENT/);
});

test('quality gate: objective title problems are detected; vision only goes to vision-named models and its text reaches the title prompt', async () => {
  const { titleIssues } = await import('../src/seo/titlegate.ts'); const { isVisionModel, describeFrames } = await import('../src/seo/vision.ts');
  assert.deepEqual(titleIssues('Rohit ne 6 ball par 6 six maare 😱 #Shorts'), []);
  assert.ok(titleIssues('AMAZING MOMENTS you must watch this full video of the best cricket match ever played today').length >= 2);
  assert.ok(titleIssues('Same Title', 'same title').includes('copy of the source title'));
  assert.equal(isVisionModel('llama-3.3-70b-versatile'), false); assert.equal(isVisionModel('gemini-3.8-flash'), true);
  let sent = 0; const f = (async (_u: string, init: { body: string }) => { sent++; const b = JSON.parse(init.body); assert.equal(b.messages[0].content.filter((c: { type: string }) => c.type === 'image_url').length, 2); return new Response(JSON.stringify({ choices: [{ message: { content: 'A man dances on a rooftop and jumps at the end.' } }] }), { status: 200 }); }) as unknown as typeof fetch;
  assert.equal(await describeFrames({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'llama-3.3-70b-versatile' }, ['a', 'b'], f), null); assert.equal(sent, 0, 'text-only model never receives images');
  assert.match((await describeFrames({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'gemini-3.8-flash' }, ['a', 'b'], f))!, /dances on a rooftop/);
  let prompt = ''; const g = (async (_u: string, init: { body: string }) => { prompt = init.body; return new Response('{}', { status: 500 }); }) as unknown as typeof fetch;
  const base = buildMetadata({ transcript: 'x', category: 'dance', language: 'hi', clipStart: 0, duration: 20 } as never);
  await llmMetadata(base, 'music only', { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }, g, [], [], null, 'A man dances on a rooftop');
  assert.match(prompt, /What is visible on screen[^"]*rooftop/);
});

test('vision quota: an image 429 pauses vision only (not the provider\'s text health); hook check flags boring titles but not the emotional one', async () => {
  const { describeFrames, resetVisionPause } = await import('../src/seo/vision.ts'); const { titleIssues } = await import('../src/seo/titlegate.ts');
  resetVisionPause(); resetLlmHealth(); let n = 0; const f = (async () => { n++; return new Response('quota', { status: 429 }); }) as unknown as typeof fetch; const env = { baseUrl: 'http://v/v1', apiKey: 'key-vvvvvv', model: 'gemini-3.8-flash' };
  assert.equal(await describeFrames(env, ['a'], f), null); assert.equal(await describeFrames(env, ['a'], f), null); assert.equal(n, 1, 'paused for an hour after the 429');
  assert.equal(allProvidersDown([env], Date.now()), false, 'text use of the same provider is not cooled');
  assert.ok(titleIssues('Cricket Match Highlights').some((x) => /no hook/.test(x))); assert.deepEqual(titleIssues('Kohli Ne Ye Kya Kar Diya?! 😱 #Shorts'), []);
});

test('local vision (Ollama etc.) is recognised, has no daily budget, and local llava/moondream names count as vision models', async () => {
  const { isLocalEndpoint, isVisionModel } = await import('../src/seo/vision.ts');
  for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://192.168.1.5:11434/v1', 'http://host.docker.internal:11434/v1']) assert.equal(isLocalEndpoint(u), true, u);
  for (const u of ['https://api.groq.com/openai/v1', 'https://generativelanguage.googleapis.com/v1beta/openai']) assert.equal(isLocalEndpoint(u), false, u);
  for (const m of ['llava:13b', 'llava-v1.6-mistral', 'moondream', 'qwen2-vl-7b', 'minicpm-v']) assert.equal(isVisionModel(m), true, m); assert.equal(isVisionModel('phi3'), false);
});

test('Telegram "Test" really delivers a message (not just a token check) and reports a failed delivery', async () => {
  const { testConnection } = await import('../src/connections.ts'); const { saveCredentials } = await import('../src/publish/direct.ts'); const { secretsFor } = await import('../src/publish/service.ts');
  const { loadConfig } = await import('../src/config.ts'); const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const cfg = loadConfig(process.cwd(), { dataDir: mkdtempSync(join(tmpdir(), 'tg-')) }); const store = new Store(':memory:'); saveCredentials(secretsFor(cfg), 'notify', { botToken: '1234567:ABCdefGHIjklMNOpqrSTUvwxyz_12', chatId: '-100123' });
  const real = globalThis.fetch; const calls: string[] = []; let sendOk = true;
  globalThis.fetch = (async (u: string) => { const url = String(u); calls.push(url.split('/').pop()!.split('?')[0]!); if (url.endsWith('getMe')) return Response.json({ ok: true, result: { username: 'mybot' } }); if (url.includes('getChat')) return Response.json({ ok: true, result: { title: 'My Channel' } }); return sendOk ? Response.json({ ok: true }) : Response.json({ ok: false, description: 'not enough rights to send' }, { status: 403 }); }) as typeof fetch;
  try {
    const a = await testConnection(store, cfg, 'notify'); assert.equal(a.ok, true); assert.ok(calls.includes('sendMessage'), 'a real message is sent'); assert.match(a.detail, /test message/);
    sendOk = false; const b = await testConnection(store, cfg, 'notify'); assert.equal(b.ok, false); assert.match(b.detail, /not enough rights/);
  } finally { globalThis.fetch = real; }
});

test('sandbox channel: real upload path is exercised ([TEST] title, unlisted, verified) but NEVER published, even when approved', async () => {
  const { advanceUpload, queueUpload } = await import('../src/publish/machine.ts'); const { testConfig } = await import('./helpers.ts');
  const store = new Store(':memory:'); store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,6,.5,'c')`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1','/tmp/o1.mp4',1)`); store.exec(`UPDATE channels SET config_json=? WHERE slug='main'`, JSON.stringify({ sandbox: true }));
  const up = queueUpload(store, 1, 'youtube'); const log: string[] = []; let vTitle = '';
  const ad = { upload: async (a: { title: string; visibility: string }) => { log.push(`upload:${a.visibility}:${a.title}`); return { remoteId: 'r1' }; }, verify: async (_id: string, e: { title: string }) => { vTitle = e.title; return { processed: true, metadataMatches: true, visibility: 'unlisted' }; }, publish: async () => { log.push('PUBLISH'); } } as never;
  const cfg = testConfig({ gates: { publishEnabled: true, publicVisibilityAllowed: true } }); const facts = { title: 'Mera clip', description: 'd', tags: [], duration: 20, durationSec: 20, width: 1080, height: 1920 } as never;
  store.exec(`UPDATE uploads SET state='UPLOADING' WHERE id=?`, up);
  assert.equal(await advanceUpload(store, cfg, ad, up, { facts }), 'UPLOAD_VERIFYING'); assert.equal(await advanceUpload(store, cfg, ad, up, { facts }), 'UNLISTED_VERIFIED');
  assert.deepEqual(log, ['upload:unlisted:[TEST] Mera clip']); assert.equal(vTitle, '[TEST] Mera clip');
  await assert.rejects(advanceUpload(store, cfg, ad, up, { facts, approve: true }), /SANDBOX_HOLD/);
  await assert.rejects(advanceUpload(store, cfg, ad, up, { facts, scheduledAt: new Date(Date.now() + 3600_000) }), /SANDBOX_HOLD/);
  assert.equal(store.get<{ state: string }>('SELECT state FROM uploads WHERE id=?', up)!.state, 'UNLISTED_VERIFIED'); assert.ok(!log.includes('PUBLISH'));
});

test('Anthropic official endpoint: temperature/top_p are not sent there (newer Claude models reject them), other hosts unchanged; provider is listed', async () => {
  const { adaptForHost } = await import('../src/ai/health.ts'); const { readFileSync } = await import('node:fs');
  const body = JSON.stringify({ model: 'claude-haiku-5-5', temperature: 0.4, messages: [] });
  assert.equal('temperature' in JSON.parse(adaptForHost('https://api.anthropic.com/v1/chat/completions', { body }).body as string), false);
  assert.equal(adaptForHost('https://api.groq.com/openai/v1/chat/completions', { body }).body, body);
  const p = (JSON.parse(readFileSync('src/ai/providers.json', 'utf8')) as { providers: { id: string; base: string; models: string[] }[] }).providers.find((x) => x.id === 'anthropic')!;
  assert.equal(p.base, 'https://api.anthropic.com/v1'); assert.ok(p.models.length >= 1);
  let seen = ''; const f = (async (_u: string, init: { body: string }) => { seen = init.body; return new Response('{}', { status: 500 }); }) as unknown as typeof fetch;
  const base = buildMetadata({ transcript: 'x', category: 'a', language: 'hi', clipStart: 0, duration: 20 } as never);
  await llmMetadata(base, 'koi baat hui yahan par kaafi lambi', { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-xxxxxxxx', model: 'claude-haiku-5-5' }, f); assert.ok(seen && !/temperature/.test(seen), 'real call path omits temperature');
});

test('CI guard: under the test runner the default installers (doctor whisper.cpp, bootstrap setup.sh) never spawn the real script', async () => {
  const { runDoctor } = await import('../src/ops/doctor.ts'); const { testConfig } = await import('./helpers.ts'); assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT');
  const before = (await import('node:fs')).readdirSync('/proc').filter((x) => /^\d+$/.test(x)).length; const store = new Store(':memory:');
  await runDoctor(store, testConfig(), { fix: true } as never).catch(() => undefined);
  const { execSync } = await import('node:child_process'); assert.equal(execSync('pgrep -fc "[i]nstall-whisper-cpp\\.sh" || true').toString().trim(), '0', 'no real installer is running'); void before;
});

test('local retention: original + raw cut of a fully published video are deleted after localKeepDays; recent / unfinished videos are kept; edited short stays', async () => {
  const { pruneFinishedLocal } = await import('../src/storage/cloud.ts'); const { loadConfig } = await import('../src/config.ts'); const fs = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const d = fs.mkdtempSync(join(tmpdir(), 'ret-')); const cfg = loadConfig(process.cwd(), { dataDir: d }); const store = new Store(':memory:');
  const mk = (n: string) => { const p = join(d, n); fs.writeFileSync(p, Buffer.alloc(2048)); return p; };
  const src1 = mk('a.mp4'), raw1 = mk('raw1.mp4'), ed1 = mk('ed1.mp4'), src2 = mk('b.mp4'), src3 = mk('c.mp4');
  for (const [id, p] of [[1, src1], [2, src2], [3, src3]] as [number, string][]) { store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (?,?,?)`, id, p, 'f' + id); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,?,0,6,.5,?)`, id, id, 'c' + id); }
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, raw_path, edited_path, qc_pass) VALUES (1,1,'o1',?,?,1)`, raw1, ed1); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (2,2,'o2','/x',1)`); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (3,3,'o3','/y',1)`);
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, updated_at) VALUES (1,'youtube','PUBLISHED','k1',datetime('now','-5 days'))`); // old + published
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, updated_at) VALUES (2,'youtube','PUBLISHED','k2',datetime('now','-1 hours'))`); // published but recent
  store.exec(`INSERT INTO uploads(clip_id, platform, state, idempotency_key, updated_at) VALUES (3,'youtube','UNLISTED_VERIFIED','k3',datetime('now','-9 days'))`); // old but not published
  const r = pruneFinishedLocal(store, cfg); assert.equal(r.videos, 1);
  assert.equal(fs.existsSync(src1), false); assert.equal(fs.existsSync(raw1), false); assert.equal(fs.existsSync(ed1), true, 'finished short is kept');
  assert.equal(fs.existsSync(src2), true); assert.equal(fs.existsSync(src3), true);
  assert.equal(pruneFinishedLocal(store, { ...cfg, storage: { ...cfg.storage, localKeepDays: 0 } }).videos, 0, '0 = keep forever');
  assert.equal(pruneFinishedLocal(store, cfg, true).videos, 1, 'disk emergency (force) also takes the recent published one'); assert.equal(fs.existsSync(src3), true);
});
