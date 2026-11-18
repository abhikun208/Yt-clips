import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.ts';
import { saveAi, llmSlot } from '../src/ai/settings.ts';
import { installModelHealing } from '../src/ai/autodetect.ts';
import { llmFetch, onStaleModel, resetLlmHealth, STALE_MODEL } from '../src/ai/health.ts';
import { tmpDir } from './helpers.ts';

test('STALE_MODEL recognises the OpenRouter withdrawal texts but not ordinary errors', () => {
  for (const t of ['Model is no longer available. No provider serves this model.', 'No endpoints found for x/y:free', 'The model `z` does not exist']) assert.match(t, STALE_MODEL);
  for (const t of ['rate limit exceeded', 'invalid api key', 'upstream timeout']) assert.doesNotMatch(t, STALE_MODEL);
});
test('a withdrawn model (HTTP 404 "no longer available") is replaced by a live, PROVEN model automatically; the old key/slot survive', async () => {
  resetLlmHealth(); let proved = 0;
  const s = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url!.endsWith('/models')) return void res.end(JSON.stringify({ data: [{ id: 'acme/good-model:free', pricing: { prompt: '0', completion: '0' } }] }));
    const m = (JSON.parse(b || '{}') as { model?: string }).model;
    if (m === 'dead/model:free') { res.statusCode = 404; return void res.end(JSON.stringify({ error: { message: 'Model is no longer available. No provider serves this model.' } })); }
    proved++; res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); }); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`;
  try {
    const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() }); saveAi(cfg, 'llm', { apiKey: 'sk-test-12345678', baseUrl: base, model: 'dead/model:free', slot: 1 });
    const logs: string[] = []; installModelHealing(cfg, (m) => logs.push(m)); await new Promise((r) => setTimeout(r, 50));
    const env = { baseUrl: base, apiKey: 'sk-test-12345678', model: 'dead/model:free' };
    const r = await llmFetch(fetch, env, `${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: env.model, messages: [] }) });
    assert.equal(r.status, 404, 'caller still sees the original response');
    for (let i = 0; i < 40 && llmSlot(cfg, 1)?.model === 'dead/model:free'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(llmSlot(cfg, 1)!.model, 'acme/good-model:free'); assert.ok(proved >= 1, 'replacement was proven with a real call'); assert.equal(llmSlot(cfg, 1)!.apiKey, 'sk-test-12345678'); assert.match(logs.join('|'), /replaced by "acme\/good-model:free"/);
  } finally { onStaleModel(null); s.close(); }
});
