import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

test('regression: a long worker job must not freeze the automation tick, and a crashing step must not stop the worker', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let autoTicks = 0; let workCalls = 0; let crashAuto = false;
  const app = createApp({ host: '127.0.0.1', port: 0, token: 'test-token-0123456789', dataDir: tmpDir(), autoRun: false,
    hooks: {
      work: async () => { workCalls++; await gate; return { done: 1, failed: 0, dead: 0 }; },
      automation: async () => { autoTicks++; if (crashAuto) throw new Error('boom'); return { queued: 0, advanced: 0, errors: [] } as never; },
    } });
  await app.start();
  try {
    void app.runOnce();                       // worker lane now blocked on `gate` (a 30-minute render in real life)
    await new Promise((r) => setTimeout(r, 300));
    void app.runOnce(); await new Promise((r) => setTimeout(r, 300));
    void app.runOnce(); await new Promise((r) => setTimeout(r, 300));
    assert.ok(autoTicks >= 3, `automation ticked ${autoTicks}x while worker was busy`);
    assert.equal(workCalls, 1, 'worker stays single-flight');
    release(); await app.runOnce();
    crashAuto = true; const before = workCalls; await app.runOnce();
    assert.ok(workCalls > before, 'worker still ran although the automation step crashed');
  } finally { release(); await app.stop(); }
});
