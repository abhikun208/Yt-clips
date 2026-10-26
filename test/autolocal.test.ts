import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rankChat, rankStt, providerFromKey, autoSetup, autoFix } from '../src/ai/autodetect.ts';
import { PRESETS, sttCreds, llmCreds, llmSlot, saveAi } from '../src/ai/settings.ts';
import { parseWhisperCppJson, runLocalCli, detectLocalEngines, probeVoiceStudio, testLocal } from '../src/analysis/localStt.ts';
import { transcribeVideo } from '../src/analysis/stt.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';

const M = (...ids: string[]) => ids.map((id) => ({ id }));
test('provider presets have the documented base URLs (xAI added)', () => {
  const b = Object.fromEntries(PRESETS.map((p) => [p.id, p.base]));
  assert.equal(b.groq, 'https://api.groq.com/openai/v1'); assert.equal(b.gemini, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(b.ollama, 'http://127.0.0.1:11434/v1'); assert.equal(b.xai, 'https://api.x.ai/v1'); assert.equal(b.openrouter, 'https://openrouter.ai/api/v1');
});
test('key prefix -> provider; ranking picks free/best chat models and drops whisper/embedding/tts', () => {
  assert.equal(providerFromKey('gsk_abc'), 'groq'); assert.equal(providerFromKey('AIzaXYZ'), 'gemini'); assert.equal(providerFromKey('sk-or-v1-x'), 'openrouter'); assert.equal(providerFromKey('xai-1'), 'xai'); assert.equal(providerFromKey('zzz'), null);
  assert.equal(rankChat('groq', M('whisper-large-v3', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'))[0], 'llama-3.3-70b-versatile');
  assert.ok(!rankChat('groq', M('whisper-large-v3', 'playai-tts', 'meta-llama/llama-guard-4-12b')).length);
  assert.equal(rankChat('gemini', M('gemini-3.8-pro', 'gemini-3.8-flash-lite', 'gemini-3.8-flash', 'text-embedding-004', 'gemini-3.8-flash-image'))[0], 'gemini-3.8-flash');
  assert.equal(rankChat('openrouter', [{ id: 'openai/gpt-5', free: false }, { id: 'meta-llama/llama-3.3-70b-instruct:free', free: true }, { id: 'openrouter/free', free: true }]).join(), 'meta-llama/llama-3.3-70b-instruct:free,openrouter/free');
  assert.equal(rankChat('xai', M('grok-3', 'grok-3-mini', 'grok-2-image'))[0], 'grok-3-mini');
  assert.equal(rankChat('ollama', M('nomic-embed-text', 'llama3.1:70b', 'llama3.2:3b', 'qwen2.5:7b'))[0], 'llama3.2:3b');
  assert.deepEqual(rankStt(M('llama-3.3-70b-versatile', 'whisper-large-v3', 'whisper-large-v3-turbo')), ['whisper-large-v3-turbo', 'whisper-large-v3']);
});
function stubFetch(o: { goodKey: string; base: string; models: string[]; badModels?: string[] }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
    const j = (code: number, b: unknown) => new Response(JSON.stringify(b), { status: code, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith(o.base)) return j(401, { error: { message: 'bad key' } });
    if (auth !== `Bearer ${o.goodKey}` && o.goodKey) return j(401, { error: { message: 'invalid key' } });
    if (u.endsWith('/models')) return j(200, { data: o.models.map((id) => ({ id })) });
    const model = JSON.parse(String(init!.body)).model as string;
    return o.badModels?.includes(model) ? j(404, { error: { message: 'model not found' } }) : j(200, { choices: [{ message: { content: 'ok' } }] });
  }) as typeof fetch;
}
test('autoSetup: only a Groq key -> provider detected, best chat model verified by a real call and saved, whisper set for STT', async () => {
  const cfg = testConfig(); const rep = await autoSetup(cfg, { apiKey: 'gsk_test' }, stubFetch({ goodKey: 'gsk_test', base: 'https://api.groq.com/openai/v1', models: ['whisper-large-v3-turbo', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] }));
  assert.equal(rep.ok, true, JSON.stringify(rep)); assert.equal(rep.provider, 'groq'); assert.equal(llmCreds(cfg)?.model, 'llama-3.3-70b-versatile'); assert.equal(sttCreds(cfg)?.model, 'whisper-large-v3-turbo');
});
test('autoSetup: falls to next model when the first 404s; unknown key shape is probed across providers; wrong key reports clearly', async () => {
  const cfg = testConfig(); const f = stubFetch({ goodKey: 'weird-key', base: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'], badModels: ['mistral-small-latest'] });
  const rep = await autoSetup(cfg, { apiKey: 'weird-key' }, f); assert.equal(rep.ok, true, JSON.stringify(rep)); assert.equal(rep.provider, 'mistral'); assert.equal(llmCreds(cfg)?.model, 'mistral-large-latest');
  const bad = await autoSetup(testConfig(), { apiKey: 'nope' }, stubFetch({ goodKey: 'x', base: 'https://api.groq.com/openai/v1', models: [] })); assert.equal(bad.ok, false);
  const rep2 = await autoSetup(testConfig(), { apiKey: 'gsk_nope' }, stubFetch({ goodKey: 'gsk_real', base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile'] })); assert.equal(rep2.ok, false); assert.match(rep2.steps.map((s) => s.text).join(), /reject/i);
});
test('autoSetup: local Ollama works with no key and picks an installed model', async () => {
  const cfg = testConfig(); const rep = await autoSetup(cfg, { provider: 'ollama' }, stubFetch({ goodKey: '', base: 'http://127.0.0.1:11434/v1', models: ['nomic-embed-text', 'llama3.2:3b'] }));
  assert.equal(rep.ok, true, JSON.stringify(rep)); assert.equal(llmCreds(cfg)?.model, 'llama3.2:3b'); assert.equal(llmCreds(cfg)?.apiKey, '');
  const none = await autoSetup(testConfig(), { provider: 'ollama' }, stubFetch({ goodKey: '', base: 'http://127.0.0.1:11434/v1', models: [] })); assert.equal(none.ok, false); assert.match(none.steps.map((s) => s.text).join(), /ollama pull/);
});
test('autoFix reuses the saved key: stale gemini model replaced by a live one; unreachable STT base explained', async () => {
  const cfg = testConfig(); saveAi(cfg, 'llm', { apiKey: 'AIzaSyTESTKEY1234567890', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', slot: 2 });
  const r = await autoFix(cfg, 'llm:2', stubFetch({ goodKey: 'AIzaSyTESTKEY1234567890', base: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-computer-use', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] })); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(llmSlot(cfg, 2)?.model, 'gemini-2.5-flash');
  saveAi(cfg, 'stt', { apiKey: 'gsk_testkey1234567890', baseUrl: 'https://stt.example.invalid/v1' }); const f = await autoFix(cfg, 'stt', (async () => { throw new Error('fetch failed'); }) as typeof fetch); assert.equal(f.ok, false); assert.match(f.steps[0]!.text, /stt\.example\.invalid/);
});
test('parseWhisperCppJson: ms offsets -> seconds, drops [BLANK_AUDIO] markers', () => {
  const r = parseWhisperCppJson(JSON.stringify({ result: { language: 'hi' }, transcription: [{ offsets: { from: 500, to: 2500 }, text: ' booyah squad ' }, { offsets: { from: 2500, to: 3000 }, text: '[BLANK_AUDIO]' }] }));
  assert.deepEqual(r.cues, [{ start: 0.5, end: 2.5, text: 'booyah squad' }]); assert.equal(r.language, 'hi');
});
test('local STT with stand-in whisper.cpp + whisper CLI binaries: detected, run, cues written to the sidecar (no API anywhere)', async () => {
  const d = tmpDir(); const bin = join(d, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'whisper-cli'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -of) of="$2";; esac; shift; done\necho \'{"result":{"language":"en"},"transcription":[{"offsets":{"from":1000,"to":3000},"text":" clutch time "}]}\' > "$of.json"\n'); chmodSync(join(bin, 'whisper-cli'), 0o755);
  writeFileSync(join(d, 'ggml-small.bin'), 'x');
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`; const oldCmd = process.env.YT_CLIPS_STT_CMD; delete process.env.YT_CLIPS_STT_CMD;
  try {
    const cfg = testConfig({ stt: { engine: 'local', cppModel: join(d, 'ggml-small.bin'), voiceStudioUrl: 'http://127.0.0.1:9' } });
    const eng = await detectLocalEngines(cfg); assert.equal(eng.find((e) => e.id === 'whisper-cpp')!.available, true); assert.equal(eng.find((e) => e.id === 'voicestudio')!.available, false);
    const t = await testLocal(cfg, 'whisper-cpp'); assert.equal(t.ok, true, t.text);
    const v = join(d, 'v.mp4'); await makeFixture(v, 3); const r = await transcribeVideo(cfg, v); assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.engine, 'whisper-cpp'); assert.equal(r.cues[0]!.text, 'clutch time'); assert.ok(existsSync(join(d, 'v.json')));
    assert.equal((await transcribeVideo(testConfig({ stt: { engine: 'api' } }), v)).status, 'unavailable');
    writeFileSync(join(bin, 'whisper'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --output_dir) od="$2";; esac; shift; done\necho \'{"language":"en","segments":[{"start":0,"end":1.5,"text":" hi","words":[{"word":" hi","start":0,"end":1.5}]}]}\' > "$od/a.json"\n'); chmodSync(join(bin, 'whisper'), 0o755);
    const w = join(d, 'a.wav'); writeFileSync(w, 'x'); const c = await runLocalCli(cfg, 'whisper-cli', w, 'auto'); assert.equal(c.cues[0]!.words![0]!.text, 'hi');
  } finally { process.env.PATH = old; if (oldCmd !== undefined) process.env.YT_CLIPS_STT_CMD = oldCmd; }
});
test('VoiceStudio probe: any HTTP answer = up; refused = down', async () => {
  assert.equal((await probeVoiceStudio('http://127.0.0.1:3900', (async () => new Response('ok', { status: 200 })) as typeof fetch)).up, true);
  assert.equal((await probeVoiceStudio('http://127.0.0.1:3900', (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch)).up, false);
});
test('simple provider save: catalog model preferred, slots assigned, key-less Ollama ok', async () => {
  const { saveProviderKey, slotFor, CATALOG } = await import('../src/ai/autodetect.ts'); const cfg = testConfig();
  assert.ok(CATALOG.length >= 6 && CATALOG.every((c) => c.models.length && /^https?:\/\//.test(c.base)));
  const g = await saveProviderKey(cfg, 'groq', 'gsk_testkey1234567890', stubFetch({ goodKey: 'gsk_testkey1234567890', base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'whisper-large-v3-turbo'] })); assert.equal(g.ok, true, JSON.stringify(g)); assert.equal(g.llm!.slot, 1);
  const o = await saveProviderKey(cfg, 'ollama', '', stubFetch({ goodKey: '', base: 'http://127.0.0.1:11434/v1', models: ['llama3.2'] })); assert.equal(o.ok, true, JSON.stringify(o)); assert.equal(o.llm!.slot, 2);
  assert.equal(slotFor(cfg, 'https://api.groq.com/openai/v1'), 1);
});
test('.env: loader (real env wins, blanks skipped) + applyEnvKeys saves/tests keys, skips unchanged, reports only names', async () => {
  const { loadDotEnv } = await import('../src/env-boot.ts'); const { applyEnvKeys, envStatus } = await import('../src/ai/envkeys.ts'); const { writeFileSync: w } = await import('node:fs');
  const d = tmpDir(); w(join(d, '.env'), 'ZZ_TEST_A="from-file"\nZZ_TEST_B=\nZZ_TEST_C=file # comment\n'); process.env.ZZ_TEST_C = 'real';
  const r = loadDotEnv(d); assert.equal(process.env.ZZ_TEST_A, 'from-file'); assert.equal(process.env.ZZ_TEST_C, 'real'); assert.equal(process.env.ZZ_TEST_B, undefined); assert.ok(r.file);
  const env = { GROQ_API_KEY: 'Bearer gsk_envkey1234567890', OLLAMA: '1' } as NodeJS.ProcessEnv; assert.deepEqual(envStatus(env).filter((x) => x.var).map((x) => x.provider), ['groq', 'ollama']);
  const cfg = testConfig(); const f = (async (u: string | URL | Request, i?: RequestInit) => String(u).startsWith('http://127') ? stubFetch({ goodKey: '', base: 'http://127.0.0.1:11434/v1', models: ['llama3.2'] })(u, i) : stubFetch({ goodKey: 'gsk_envkey1234567890', base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile'] })(u, i)) as typeof fetch;
  const a = await applyEnvKeys(cfg, { env, fetchFn: f }); assert.ok(a.every((x) => x.report?.ok), JSON.stringify(a)); assert.equal(llmCreds(cfg)?.apiKey, 'gsk_envkey1234567890');
  const b = await applyEnvKeys(cfg, { env, fetchFn: f }); assert.equal(b.find((x) => x.provider === 'groq')!.skipped, true);
});
test('Gemini: /models returns "models/" prefixed ids in `data` -> still ranked (regression: "Koi chat model nahi mila"); new AQ. keys map to gemini; keyShape never prints the key', async () => {
  const { providerFromKey: pk, keyShape } = await import('../src/ai/autodetect.ts'); assert.equal(pk('AQ.Ab8RN6xyz'), 'gemini');
  const cfg = testConfig(); const f = (async (u: string | URL | Request, i?: RequestInit) => String(u).endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }, { id: 'models/gemini-2.5-pro' }] })) : new Response(JSON.stringify({ choices: [{}] }), { status: JSON.parse(String(i!.body)).model === 'gemini-2.5-flash' ? 200 : 404 })) as typeof fetch;
  const r = await autoSetup(cfg, { apiKey: 'AQ.Ab8RN6testkey1234567', provider: 'gemini' }, f); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(llmCreds(cfg)?.model, 'gemini-2.5-flash');
  const sh = keyShape(' "AQ.Ab8 secret" '); assert.equal(sh.start, '"AQ.'); assert.ok(sh.problems.length >= 2); assert.ok(!JSON.stringify(sh).includes('secret'));
});

test('busy providers: 503 / 200-with-rate-limit-body accepted as "model exists"; OpenRouter prefers known free models over obscure ones', async () => {
  assert.equal(rankChat('openrouter', [{ id: 'xingchen-agi/xing4.0-29b-a4b:free', free: true }, { id: 'meta-llama/llama-3.3-70b-instruct:free', free: true }, { id: 'openrouter/free', free: true }])[0], 'meta-llama/llama-3.3-70b-instruct:free');
  const f = (async (u: string | URL | Request) => String(u).endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'gemini-2.5-flash' }, { id: 'gemini-3.8-flash' }] })) : new Response('{}', { status: 503 })) as typeof fetch;
  const r = await autoSetup(testConfig(), { apiKey: 'AQ.keykeykeykeykeykey', provider: 'gemini' }, f); assert.equal(r.ok, true, JSON.stringify(r));
});

test('provider names the replacement model in its 404 -> tried next; router id never goes first on OpenRouter', async () => {
  const f = (async (u: string | URL | Request, i?: RequestInit) => { if (String(u).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gemini-2.5-flash' }] })); const m = JSON.parse(String(i!.body)).model; return m === 'gemini-3.8' ? new Response(JSON.stringify({ choices: [{}] })) : new Response(JSON.stringify({ error: { message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8' } }), { status: 404 }); }) as typeof fetch;
  const cfg = testConfig(); const r = await autoSetup(cfg, { apiKey: 'AQ.keykeykeykeykeykey', provider: 'gemini' }, f); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(llmCreds(cfg)?.model, 'gemini-3.8');
});
test('multi-key env: GEMINI_API_KEY_2 gets its own fallback slot; failing keys take no slot; local hardware recommendation scales with RAM', async () => {
  const { applyEnvKeys, envStatus } = await import('../src/ai/envkeys.ts'); const { recommend } = await import('../src/localcheck.ts');
  const env = { GEMINI_API_KEY: 'AQ.firstkey1234567890', GEMINI_API_KEY_2: 'AQ.secondkey123456789', GROQ_API_KEY: 'gsk_bad1234567890' } as NodeJS.ProcessEnv;
  assert.deepEqual(envStatus(env).filter((x) => x.var).map((x) => x.var), ['GROQ_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEY_2']);
  const ok = (key: string, base: string) => stubFetch({ goodKey: key, base, models: ['gemini-3.8-flash', 'llama-3.3-70b-versatile'] });
  const f = (async (u: string | URL | Request, i?: RequestInit) => String(u).includes('groq') ? new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 }) : ok(String((i?.headers as Record<string, string>)?.authorization ?? '').slice(7), 'https://generativelanguage.googleapis.com/v1beta/openai')(u, i)) as typeof fetch;
  const cfg = testConfig(); const r = await applyEnvKeys(cfg, { env, fetchFn: f }); assert.deepEqual(r.map((x) => !!x.report?.ok), [false, true, true]);
  assert.equal(llmSlot(cfg, 1)?.apiKey, 'AQ.firstkey1234567890'); assert.equal(llmSlot(cfg, 2)?.apiKey, 'AQ.secondkey123456789'); assert.equal(llmSlot(cfg, 3), null);
  assert.equal(recommend(2, true).whisper, 'tiny'); assert.equal(recommend(6, false).llm, 'llama3.2:3b'); assert.equal(recommend(2, true).llm, 'none');
});
test('Gemini audio STT fallback: chunks offset to full timeline, code fences tolerated, busy chunks retried, no engine => used only when allowed', async () => {
  const { transcribeViaGemini, parseGeminiSegments } = await import('../src/analysis/geminiStt.ts');
  assert.deepEqual(parseGeminiSegments('```json\n[{"start":1,"end":2.5,"text":" booyah "},{"start":"x","end":2,"text":"bad"}]\n```', 90, 90), [{ start: 91, end: 92.5, text: 'booyah' }]);
  const d = tmpDir(); const v = join(d, 'g.mp4'); await makeFixture(v, 6); let n = 0; const bodies: string[] = [];
  const f = (async (_u: string | URL | Request, i?: RequestInit) => { bodies.push(String(i!.body).slice(0, 4000)); n++; return n === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: '[{"start":0.5,"end":2,"text":"hello squad"}]' } }] })); }) as typeof fetch;
  const r = await transcribeViaGemini(v, d, { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, { chunkSec: 10, fetchFn: f, gapMs: 1 }); assert.ok(r.cues.length >= 1 && r.cues[0]!.text === 'hello squad'); assert.ok(bodies[0]!.includes('input_audio'));
});

test('whisper.cpp word-mode output (-ml 1 -sow) is regrouped into caption cues with per-word times', () => {
  const w = (t: string, a: number, b: number) => ({ offsets: { from: a, to: b }, text: ' ' + t });
  const r = parseWhisperCppJson(JSON.stringify({ transcription: [w('Booyah', 0, 400), w('squad,', 400, 900), w('push', 1000, 1300), w('now.', 1300, 1700), w('Next', 3000, 3300), w('one', 3300, 3600)] }));
  assert.equal(r.cues.length, 2); assert.equal(r.cues[0]!.text, 'Booyah squad, push now.'); assert.equal(r.cues[0]!.words!.length, 4); assert.equal(r.cues[1]!.start, 3); assert.equal(r.cues[1]!.text, 'Next one');
});
test('channel polling: new uploads discovered, result recorded for the UI, failures explained in plain words', async () => {
  const { pollSources, explainYtdlp, addYoutubeSource } = await import('../src/sources/youtube.ts'); const { Store } = await import('../src/db.ts');
  assert.match(explainYtdlp("ERROR: Sign in to confirm you're not a bot"), /YT_DLP_COOKIES/); assert.match(explainYtdlp('ERROR: HTTP Error 404'), /link galat/);
  const d = tmpDir(); const bin = join(d, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'yt-dlp'), '#!/bin/sh\ncase "$*" in *--help*) echo "  --js-runtimes RUNTIME";; *--flat-playlist*) echo \'{"entries":[{"id":"abcdefghijk","title":"Old stream","duration":99999},{"id":"lmnopqrstuv","title":"Live 2","duration":99999}]}\';; esac\n'); chmodSync(join(bin, 'yt-dlp'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const cfg = testConfig(); const store = new Store(join(cfg.dataDir, 'x.db')); addYoutubeSource(store, 'https://www.youtube.com/@teamunknown', true);
    const r = await pollSources(store, cfg); assert.equal(r.channels, 1); assert.equal(r.skipped, 2); assert.equal(r.error, undefined);
    assert.equal(JSON.parse(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='poll:last'`)!.v).skipped, 2);
    assert.equal(store.all(`SELECT 1 FROM sources WHERE kind='youtube_video'`).length, 2);
  } finally { process.env.PATH = old; }
});
test('cloud storage (rclone stand-in): finished source is copied + size-verified, local original deleted, restored on demand, purged after N days; unfinished sources untouched', async () => {
  const { storageTick, ensureLocal, testRemote, finishedVideos } = await import('../src/storage/cloud.ts'); const { Store } = await import('../src/db.ts'); const { existsSync: ex, mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = await import('node:fs');
  const d = tmpDir(); const bin = join(d, 'bin'); const root = join(d, 'cloud'); mk(bin, { recursive: true }); mk(root, { recursive: true });
  wf(join(bin, 'rclone'), `#!/bin/sh\nR="${root}"\nmap() { echo "$1" | sed "s#^fake:#$R/#"; }\ncase "$1" in\n listremotes) echo "fake:";;\n copyto) mkdir -p "$(dirname "$(map "$3")")"; cp "$(map "$2")" "$(map "$3")" 2>/dev/null || exit 1;;\n lsjson) f="$(map "$2")"; [ -f "$f" ] && echo "[{\\"Name\\":\\"$(basename "$f")\\",\\"Size\\":$(wc -c < "$f")}]" || echo "[]";;\n purge) rm -rf "$(map "$2")";;\nesac\n`); chmodSync(join(bin, 'rclone'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const cfg = testConfig({ storage: { remote: 'fake:studio', deleteLocal: true, purgeAfterDays: 1 } }); const store = new Store(join(cfg.dataDir, 'c.db')); assert.equal((await testRemote(cfg)).ok, true);
    const mkVideo = (n: number, state: string) => { const p = join(d, `v${n}.mp4`); wf(p, 'x'.repeat(100 + n)); wf(join(d, `v${n}.json`), '[]'); const vid = store.exec('INSERT INTO videos(path,fingerprint,size) VALUES (?,?,?)', p, 'fp' + n, 1).lastId; const cand = store.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,fingerprint) VALUES (?,?,?,?,?)`, vid, 0, 10, 1, 'c' + n).lastId; const clip = store.exec(`INSERT INTO clips(candidate_id,output_id) VALUES (?,?)`, cand, 'o' + n).lastId; store.exec(`INSERT INTO uploads(clip_id,platform,state,idempotency_key) VALUES (?,?,?,?)`, clip, 'youtube', state, 'k' + n); return { vid, p }; };
    const done = mkVideo(1, 'PUBLISHED'), wip = mkVideo(2, 'UNLISTED_VERIFIED'); assert.deepEqual(finishedVideos(store).map((x) => x.id), [done.vid]);
    const r = await storageTick(store, cfg); assert.equal(r.archived, 1, JSON.stringify(r)); assert.ok(!ex(done.p)); assert.ok(ex(wip.p)); assert.ok(ex(join(root, 'studio', 'raw', String(done.vid), 'v1.mp4')));
    await ensureLocal(store, cfg, done.p); assert.equal(rf(done.p, 'utf8').length, 101);
    store.exec(`UPDATE kv SET v=json_set(v,'$.doneAt','2000-01-01T00:00:00.000Z') WHERE k LIKE 'cloud:video:%'`); const r2 = await storageTick(store, cfg); assert.equal(r2.purged, 1); assert.ok(!ex(join(root, 'studio', 'raw', String(done.vid))));
  } finally { process.env.PATH = old; }
});
