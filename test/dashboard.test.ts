import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { UI_HTML } from '../src/server/ui.ts';
import { tmpDir } from './helpers.ts';

const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
async function boot() { const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const port = await app.start(); return { app, base: `http://127.0.0.1:${port}` }; }

test('dashboard HTML: script parses, every tab + panel present, no external resources', () => {
  const js = /<script>([\s\S]*)<\/script>/.exec(UI_HTML)![1]!; assert.doesNotThrow(() => new Function(js));
  for (const id of ['t-home', 't-clips', 't-publish', 't-insights', 't-studio', 't-settings', 'apq', 'aiprov', 'dlg', 'setup', 'feed']) assert.ok(UI_HTML.includes(`id="${id}"`), id);
  assert.ok(!/(src|href)=["']https?:\/\//.test(UI_HTML), 'no CDN/external assets');
});

test('setup/activity/autopilot/source-status APIs: autopilot cannot touch gates or autoApprove; every change is logged', async () => {
  const { app, base } = await boot();
  try {
    const su = await (await fetch(`${base}/api/setup`, { headers: auth })).json() as { items: { id: string; ok: boolean }[]; ready: boolean }; assert.ok(su.items.find((i) => i.id === 'ffmpeg')!.ok); assert.equal(typeof su.ready, 'boolean');
    const ac = await (await fetch(`${base}/api/activity`, { headers: auth })).json() as { log: unknown[]; jobs: unknown[] }; assert.ok(Array.isArray(ac.log) && Array.isArray(ac.jobs));
    const post = (b: unknown) => fetch(`${base}/api/autopilot`, { method: 'POST', headers: auth, body: JSON.stringify(b) });
    assert.equal((await post({ autoQueue: true, requireReview: true, platforms: ['youtube_shorts', 'tiktok'] })).status, 200);
    const st = await (await fetch(`${base}/api/autopilot`, { headers: auth })).json() as { automation: { autoQueue: boolean; requireReview: boolean; platforms: string[]; autoApprove: boolean }; gates: Record<string, boolean> };
    assert.equal(st.automation.autoQueue, true); assert.equal(st.automation.requireReview, true); assert.deepEqual(st.automation.platforms, ['youtube_shorts', 'tiktok']);
    for (const bad of [{ autoApprove: true }, { gates: { publishEnabled: true } }, { publishEnabled: true }]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post({ platforms: ['myspace'] })).status, 400); assert.equal((await post({ autoQueue: 'yes' })).status, 400);
    const after = await (await fetch(`${base}/api/autopilot`, { headers: auth })).json() as typeof st; assert.equal(after.automation.autoApprove, false); assert.ok(Object.values(after.gates).every((v) => v === false), 'gates still closed');
    const log = (await (await fetch(`${base}/api/activity`, { headers: auth })).json() as { log: { entity: string }[] }).log; assert.ok(log.some((l) => l.entity === 'autopilot'));
    assert.equal((await fetch(`${base}/api/sources/999/status`, { method: 'POST', headers: auth, body: JSON.stringify({ status: 'paused' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/clips/999/review`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'approve' }) })).status, 400, 'unknown clip is a 400, not 500');
    assert.equal((await fetch(`${base}/api/clips/1/rerender`, { method: 'POST', headers: auth, body: '{}' })).status, 400);
    assert.ok(!JSON.stringify(su).includes(TOKEN));
  } finally { await app.stop(); }
});

test('AI settings API: keyless local endpoint accepted, remote without key rejected, key never echoed', async () => {
  const { app, base } = await boot();
  try {
    const p = (b: unknown) => fetch(`${base}/api/settings/ai`, { method: 'POST', headers: auth, body: JSON.stringify(b) });
    assert.equal((await p({ kind: 'llm', baseUrl: 'https://api.groq.com/openai/v1' })).status, 400);
    assert.equal((await p({ kind: 'llm', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' })).status, 200);
    assert.equal((await p({ kind: 'llm', apiKey: 'sk_secret_value_123', baseUrl: 'https://openrouter.ai/api/v1', slot: 2 })).status, 200);
    const s = await (await fetch(`${base}/api/settings`, { headers: auth })).text(); assert.ok(!s.includes('sk_secret_value_123')); const j = JSON.parse(s) as { ai: { chain: unknown[]; presets: { id: string }[] } }; assert.equal(j.ai.chain.length, 2); assert.ok(j.ai.presets.some((x) => x.id === 'ollama'));
  } finally { await app.stop(); }
});
void join;
