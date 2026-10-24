import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateCues } from '../src/ai/translate.ts';

const chain = [{ baseUrl: 'http://x/a', apiKey: 'k', model: 'm1' }, { baseUrl: 'http://x/b', apiKey: '', model: 'm2' }];
const cues = [{ start: 1, end: 2.5, text: 'arre ye kya hua' }, { start: 3, end: 4, text: 'booyah squad wipe' }];
const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content: typeof body === 'string' ? body : JSON.stringify(body) } }] }) }) as unknown as Response;

test('translateCues: keeps timing, falls through bad providers, rejects wrong line counts, never fabricates', async () => {
  const seen: string[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push(url); const b = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    if (url.endsWith('/a/chat/completions')) return reply({ lines: ['only one'] }); // wrong count -> rejected
    assert.match(b.messages[0]!.content, /English/); return reply('```json\n{"lines":["Oh wow, what happened","booyah squad wipe"]}\n```'); }) as unknown as typeof fetch;
  const r = await translateCues(cues, 'en', chain, f);
  assert.deepEqual(r.cues.map((c) => [c.start, c.end, c.text]), [[1, 2.5, 'Oh wow, what happened'], [3, 4, 'booyah squad wipe']]); assert.equal(r.used, 'm2'); assert.equal(seen.length, 2);
  const bad = await translateCues(cues, 'hi', chain, (async () => reply({ lines: [] })) as unknown as typeof fetch);
  assert.deepEqual(bad.cues, cues); assert.equal(bad.used, null); assert.ok(bad.note);
  assert.equal((await translateCues(cues, 'en', [])).used, null);
  const down = await translateCues(cues, 'en', chain, (async () => reply('x', false)) as unknown as typeof fetch); assert.deepEqual(down.cues, cues);
});
