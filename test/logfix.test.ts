import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadata } from '../src/seo/metadata.ts';
import { Store } from '../src/db.ts';
import { runDoctor } from '../src/ops/doctor.ts';
import { testConfig } from './helpers.ts';

test('no speech: title/keywords come from the SOURCE title, still flagged generic', () => {
  const m = buildMetadata({ transcript: '', category: 'general', language: 'hi', sourceTitle: 'Free Fire Grandmaster Rush Gameplay', channelName: 'Team Unknown' } as never);
  assert.match(m.title, /Free Fire Grandmaster Rush Gameplay/); assert.ok(m.keywords.some((k) => /grandmaster|gameplay|rush/i.test(k))); assert.equal(m.generic, true);
});

test('doctor tells the owner plainly when cloud STT failed and no local engine exists', async () => {
  const stt = await import('../src/analysis/stt.ts'); const cfg = testConfig(); const store = new Store(':memory:');
  assert.ok(!(await runDoctor(store, cfg, { fix: false })).items.some((i) => i.area === 'speech-to-text'));
  stt.noteApiSttError('fetch failed');
  const old = process.env.PATH; process.env.PATH = '/nonexistent'; delete process.env.YT_CLIPS_STT_CMD;
  try { const it = (await runDoctor(store, cfg, { fix: false })).items.find((i) => i.area === 'speech-to-text'); assert.ok(it, 'reported'); assert.match(it!.action, /install-whisper-cpp/); assert.equal(it!.result, 'manual'); } finally { process.env.PATH = old; }
});
