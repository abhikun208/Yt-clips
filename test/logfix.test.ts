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

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir, makeFixture } from './helpers.ts';
test('engine=api + unreachable cloud STT falls back to local whisper.cpp (and trips the breaker)', async () => {
  const d = tmpDir(); const bin = join(d, 'bin'); mkdirSync(bin); const model = join(d, 'm.bin'); writeFileSync(model, 'x');
  writeFileSync(join(bin, 'whisper-cli'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then P="$2"; fi; shift; done\necho '{"result":{"language":"hi"},"transcription":[{"offsets":{"from":0,"to":2000},"text":" yeh ek test hai"}]}' > "$P.json"\n`); chmodSync(join(bin, 'whisper-cli'), 0o755);
  const v = join(d, 'v.mp4'); await makeFixture(v, 6);
  const env = { PATH: process.env.PATH, K: process.env.STT_API_KEY, B: process.env.STT_API_BASE, M: process.env.YT_CLIPS_WHISPER_CPP_MODEL, C: process.env.YT_CLIPS_STT_CMD };
  process.env.PATH = `${bin}:${env.PATH}`; process.env.STT_API_KEY = 'k'; process.env.STT_API_BASE = 'http://127.0.0.1:1/v1'; process.env.YT_CLIPS_WHISPER_CPP_MODEL = model; delete process.env.YT_CLIPS_STT_CMD;
  try {
    const { transcribeVideo, resetApiBreaker } = await import('../src/analysis/stt.ts'); resetApiBreaker();
    const r = await transcribeVideo(testConfig({ stt: { mode: 'auto', model: 'small', language: 'auto', engine: 'api' } }), v);
    assert.equal(r.status, 'ok', JSON.stringify(r)); assert.match(r.cues[0]!.text, /yeh ek test/); assert.equal(r.engine, 'whisper-cpp');
  } finally { process.env.PATH = env.PATH; for (const [k, e] of [['STT_API_KEY', env.K], ['STT_API_BASE', env.B], ['YT_CLIPS_WHISPER_CPP_MODEL', env.M], ['YT_CLIPS_STT_CMD', env.C]] as const) { if (e === undefined) delete process.env[k]; else process.env[k] = e; } }
});
