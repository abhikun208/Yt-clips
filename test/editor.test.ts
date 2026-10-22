import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyCueEdits, loadTranscript, type Cue } from '../src/analysis/transcript.ts';
import { llmMetadata, llmFromEnv } from '../src/seo/llm.ts';
import { buildMetadata } from '../src/seo/metadata.ts';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

const cues = (): Cue[] => [{ start: 0, end: 2, text: 'ye bhai bahut mast', words: [{ start: 0, end: .5, text: 'ye' }, { start: .5, end: 1, text: 'bhai' }, { start: 1, end: 1.5, text: 'bahut' }, { start: 1.5, end: 2, text: 'mast' }] }];

test('applyCueEdits: word fix keeps timing; same-count text keeps timing; different count drops word timing; bad input rejected; original untouched', () => {
  const orig = cues(); const a = applyCueEdits(orig, [{ cue: 0, words: [{ i: 2, text: 'bohot' }] }]); assert.equal(a[0]!.text, 'ye bhai bohot mast'); assert.equal(a[0]!.words![2]!.start, 1); assert.equal(orig[0]!.words![2]!.text, 'bahut');
  assert.equal(applyCueEdits(orig, [{ cue: 0, text: 'a b c d' }])[0]!.words![3]!.text, 'd');
  assert.equal(applyCueEdits(orig, [{ cue: 0, text: 'a b c' }])[0]!.words, undefined);
  assert.throws(() => applyCueEdits(orig, [{ cue: 5, text: 'x' }]), /invalid/); assert.throws(() => applyCueEdits(orig, [{ cue: 0, words: [{ i: 9, text: 'x' }] }]), /invalid/); assert.throws(() => applyCueEdits(orig, [{ cue: 0, text: ' ' }]), /invalid/);
});

test('LLM metadata: valid JSON merged; failures fall back to template with a warning; disabled without env', async () => {
  assert.equal(llmFromEnv({}), null); const env = { baseUrl: 'http://x', apiKey: 'k', model: 'm' };
  const base = buildMetadata({ transcript: 'yaar ye cricket match ka sach hai', category: 'general', language: 'hinglish' });
  const ok = await llmMetadata(base, 'tx', env, (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'sure ```json {"title":"Match Ka Sach","description":"desc","tags":["cricket"],"thumbnailText":"SACH"} ```' } }] }))) as typeof fetch);
  assert.equal(ok.source, 'llm'); assert.match(ok.title, /Match Ka Sach #Shorts/); assert.deepEqual(ok.tags, ['cricket']);
  for (const f of [async () => new Response('x', { status: 500 }), async () => new Response(JSON.stringify({ choices: [{ message: { content: 'no json' } }] })), async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"title":""}' } }] })), async () => { throw new Error('net'); }]) {
    const r = await llmMetadata(base, 'tx', env, f as unknown as typeof fetch); assert.equal(r.source, 'template'); assert.equal(r.title, base.title); assert.ok(r.warnings.some((w) => /llm metadata skipped/.test(w)));
  }
});

test('transcript edit API: GET cues, POST edits -> .edited.json wins, original kept; auth + validation', async () => {
  const TOKEN = 'test-token-0123456789'; const h = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const d = tmpDir(); const vp = join(d, 'v.mp4'); writeFileSync(vp, 'x'); writeFileSync(join(d, 'v.json'), JSON.stringify(cues()));
    app.store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1, ?, 'f')`, vp);
    assert.equal((await fetch(`${base}/api/transcript?video=1`)).status, 401);
    const g = await (await fetch(`${base}/api/transcript?video=1`, { headers: h })).json() as any; assert.equal(g.cues[0].words.length, 4);
    assert.equal((await fetch(`${base}/api/transcript/edit?video=1`, { method: 'POST', headers: h, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/api/transcript/edit?video=1`, { method: 'POST', headers: h, body: JSON.stringify({ edits: [{ cue: 0, words: [{ i: 0, text: 'yeh' }] }] }) })).status, 200);
    assert.ok(existsSync(join(d, 'v.json'))); assert.equal(loadTranscript(join(d, 'v'))[0]!.text, 'yeh bhai bahut mast');
    assert.equal((await fetch(`${base}/api/transcript/edit?video=9`, { method: 'POST', headers: h, body: '{}' })).status, 404);
  } finally { await app.stop(); }
});
