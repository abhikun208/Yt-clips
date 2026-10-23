import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { saveAi, llmChain, llmCreds, isLocalBase, aiStatus, PRESETS } from '../src/ai/settings.ts';
import { rerankCandidates } from '../src/ai/rerank.ts';
import { llmMetadata } from '../src/seo/llm.ts';
import { buildMetadata } from '../src/seo/metadata.ts';
import { testConfig } from './helpers.ts';
import type { Candidate } from '../src/analysis/select.ts';

async function fakeLlm(handler: (body: { messages: { content: string }[] }, auth?: string) => { status: number; content?: string }): Promise<{ s: Server; base: string; hits: number }> {
  const o = { s: null as unknown as Server, base: '', hits: 0 };
  o.s = createServer(async (req, res) => { const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer); o.hits++; const r = handler(JSON.parse(Buffer.concat(ch).toString()), req.headers.authorization); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: r.content ?? '' } }] })); });
  await new Promise<void>((ok) => o.s.listen(0, '127.0.0.1', ok)); o.base = `http://127.0.0.1:${(o.s.address() as { port: number }).port}`; return o;
}
const cand = (i: number, score: number): Candidate => ({ start: i * 30, end: i * 30 + 25, duration: 25, score, category: 'general', reason: 'r', hook: 'h', transcript: `this is clip number ${i} with enough words to be judged properly by the model`, language: 'en', confidence: 0.7, signals: {} });

test('keyless: localhost endpoints (Ollama/LM Studio) need no key; remote endpoints still do', () => {
  assert.ok(isLocalBase('http://127.0.0.1:11434/v1') && isLocalBase('http://localhost:1234/v1') && isLocalBase('http://192.168.1.5:8080/v1'));
  assert.ok(!isLocalBase('https://api.groq.com/openai/v1') && !isLocalBase('not a url'));
  const cfg = testConfig();
  assert.throws(() => saveAi(cfg, 'llm', { baseUrl: 'https://api.groq.com/openai/v1' }), /apiKey required/);
  saveAi(cfg, 'llm', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' });
  const c = llmCreds(cfg)!; assert.equal(c.apiKey, ''); assert.equal(c.model, 'llama3.2'); assert.equal(aiStatus(cfg).llm.ready, true);
  saveAi(cfg, 'llm', { apiKey: 'gsk_remote_key', baseUrl: 'https://api.groq.com/openai/v1', slot: 2 });
  assert.equal(llmChain(cfg).length, 2); assert.ok(PRESETS.some((p) => p.id === 'ollama' && !p.needsKey));
  assert.ok(!JSON.stringify(aiStatus(cfg)).includes('gsk_remote_key'), 'status never leaks keys');
});

test('rerank: LLM only scores our candidates (blend 0.7/0.3), ignores junk ids, falls through a failing provider, no-ops when all fail', async () => {
  const bad = await fakeLlm(() => ({ status: 500 })); const good = await fakeLlm((b) => ({ status: 200, content: 'ok ```json ' + JSON.stringify({ scores: [{ id: 1, score: 10, why: 'strong hook' }, { id: 0, score: 0, why: 'weak' }, { id: 99, score: 9 }, { id: 2, score: 55 }] }) + '```' }));
  try {
    const cs = [cand(0, 0.8), cand(1, 0.6), cand(2, 0.5)];
    const r = await rerankCandidates(cs, [{ baseUrl: bad.base, apiKey: '', model: 'm' }, { baseUrl: good.base, apiKey: 'k', model: 'm' }]);
    assert.ok(r.used?.startsWith(good.base)); assert.equal(bad.hits, 1);
    const byStart = new Map(r.cands.map((c) => [c.start, c])); assert.ok(Math.abs(byStart.get(30)!.score - (0.7 * 0.6 + 0.3)) < 1e-3); assert.ok(Math.abs(byStart.get(0)!.score - 0.56) < 1e-3);
    assert.equal(byStart.get(60)!.score, 0.5, 'out-of-range score ignored'); assert.match(byStart.get(30)!.reason, /AI 10\/10: strong hook/); assert.ok(r.cands.every((c) => cs.some((o) => o.start === c.start)), 'no invented clips');
    const none = await rerankCandidates(cs, [{ baseUrl: bad.base, apiKey: '', model: 'm' }]); assert.equal(none.used, null); assert.deepEqual(none.cands.map((c) => c.score), [0.8, 0.6, 0.5]);
  } finally { bad.s.close(); good.s.close(); }
});

test('keyless local LLM drives metadata: no Authorization header is sent', async () => {
  let auth: string | undefined = 'unset';
  const f = await fakeLlm((_b, a) => { auth = a; return { status: 200, content: JSON.stringify({ title: 'Cash flow ka asli sach 💸', titles: ['Alt 1 title here'], description: 'Cash flow check karo.\nFollow karo.', tags: ['cashflow', 'investing'], thumbnailText: 'CASH FLOW' }) }; });
  try {
    const base = buildMetadata({ transcript: 'Never invest without checking the cash flow. Cash flow shows health of a company. Most beginners ignore it.', category: 'general', language: 'en' });
    const m = await llmMetadata(base, 'Never invest without checking the cash flow. Cash flow shows health.', { baseUrl: f.base, apiKey: '', model: 'llama3.2' });
    assert.equal(m.source, 'llm'); assert.equal(auth, undefined);
  } finally { f.s.close(); }
});
