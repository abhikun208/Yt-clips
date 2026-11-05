import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { parseRssTitles, fetchTrends, relevantTrends } from '../src/seo/trends.ts';
import { llmMetadata } from '../src/seo/llm.ts';
import { buildMetadata } from '../src/seo/metadata.ts';
import { ingestComment, llmDraftReplies } from '../src/comments/comments.ts';
import { autoReplyTick } from '../src/publish/service.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';

const RSS = `<rss><channel><title>Top</title><item><title>Rohit Sharma hits record century against Australia - NDTV</title></item><item><title><![CDATA[Budget 2027: new tax slabs announced - The Hindu]]></title></item><item><title>Unrelated celebrity wedding photos viral - X</title></item></channel></rss>`;

test('trends: RSS parsed (CDATA, source suffix dropped), cached 6 h, a dead feed never breaks; only trends SPOKEN in the video are used', async () => {
  const t = parseRssTitles(RSS); assert.deepEqual(t.slice(0, 2), ['Rohit Sharma hits record century against Australia', 'Budget 2027: new tax slabs announced']);
  const store = new Store(':memory:'); let calls = 0; const f = (async (u: string) => { calls++; if (/dead/.test(u)) throw new Error('down'); return new Response(RSS, { status: 200 }); }) as unknown as typeof fetch;
  const a = await fetchTrends(store, { fetchFn: f, feeds: ['http://feed/ok', 'http://feed/dead'], now: 1_000 }); assert.equal(a.length, 3); const b = await fetchTrends(store, { fetchFn: f, feeds: ['http://feed/ok'], now: 2_000 }); assert.deepEqual(b, a); assert.equal(calls, 2, 'second call served from cache');
  assert.deepEqual(relevantTrends('aaj Rohit Sharma ne kamaal ki batting ki century maari', a), ['Rohit Sharma']);
  assert.deepEqual(relevantTrends('ye recipe bahut tasty hai, chai banate hain', a), [], 'a trend the video never mentions is NOT injected (misleading-metadata rule)');
});

test('title writer gets ONLY relevant trends, with an honesty instruction; none => prompt untouched', async () => {
  const bodies: string[] = []; const f = (async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body).messages[0].content); return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Rohit ka century 😱"}' } }] }), { status: 200 }); }) as unknown as typeof fetch;
  const base = buildMetadata({ transcript: 'Rohit Sharma ne century maari', category: 'sports', language: 'en' } as never);
  await llmMetadata(base, 'Rohit Sharma ne century maari', { baseUrl: 'http://x', apiKey: '', model: 'm' }, f, ['Rohit Sharma']); await llmMetadata(base, 'Rohit Sharma ne century maari', { baseUrl: 'http://x', apiKey: '', model: 'm' }, f, []);
  assert.match(bodies[0]!, /Trending in India right now AND spoken in this video: Rohit Sharma.*AT MOST ONE/s); assert.ok(!/Trending in India/.test(bodies[1]!));
});

test('auto-reply: OFF by default; when ON only LLM-written replies to PRAISE older than 15 min are sent; questions stay drafts; failures never lose the draft', async () => {
  const d = tmpDir(); const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: d });
  ingestComment(store, 'youtube_shorts', 'p1', 'Zabardast video bhai, bahut mast laga'); ingestComment(store, 'youtube_shorts', 'p2', 'Awesome work, love it'); ingestComment(store, 'youtube_shorts', 'q1', 'Ye kaise banate ho bhai?');
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Shukriya bhai, dil se!' } }] }), { status: 200 })) as unknown as typeof fetch;
  await llmDraftReplies(store, [{ baseUrl: 'http://x', model: 'm' }], { fetchFn: f }); store.exec(`UPDATE comments SET created_at=datetime('now','-1 hour') WHERE remote_id IN ('p1','q1')`); // p2 is "fresh"
  const posted: number[] = []; const poster = async (id: number) => { posted.push(id); store.exec(`UPDATE comments SET status='posted' WHERE id=?`, id); };
  assert.deepEqual(await autoReplyTick(store, cfg, poster), { sent: 0, skipped: 0 }, 'default OFF');
  const on = { ...cfg, gates: { ...cfg.gates, commentsAutoPost: true }, comments: { ...cfg.comments, autoReply: true } };
  const r = await autoReplyTick(store, on, poster); assert.equal(r.sent, 1, 'only p1: praise + old enough + LLM-written'); const st = (rid: string) => store.get<{ status: string }>('SELECT status FROM comments WHERE remote_id=?', rid)!.status;
  assert.equal(st('p1'), 'posted'); assert.equal(st('p2'), 'draft', 'too fresh'); assert.equal(st('q1'), 'draft', 'question never auto-sent');
  store.exec(`UPDATE comments SET created_at=datetime('now','-1 hour') WHERE remote_id='p2'`); const failing = async () => { throw new Error('QUOTA_EXCEEDED: cap'); };
  const r2 = await autoReplyTick(store, on, failing); assert.equal(r2.sent, 0); assert.equal(st('p2'), 'draft', 'a failed send leaves the draft for the owner');
});
