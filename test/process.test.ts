import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpDir } from './helpers.ts';

const MAIN = 'src/server/main.ts';
function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], { env: { ...process.env, AUTO_RUN: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
  return { child, exited, get out() { return out; }, get err() { return err; } };
}
const until = async (f: () => boolean, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('real process: boots from env, serves /healthz, exits 0 on SIGTERM (graceful)', { timeout: 60_000 }, async () => {
  const p = start({ HOST: '127.0.0.1', PORT: '0', YT_CLIPS_DATA_DIR: tmpDir(), YT_CLIPS_TOKEN: 'process-test-token-123' });
  assert.ok(await until(() => p.out.includes('server listening')), `no listen log: ${p.err}`);
  const port = JSON.parse(p.out.split('\n').find((l) => l.includes('server listening'))!).ctx.port;
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as any; assert.equal(h.ok, true);
  assert.ok(!p.out.includes('process-test-token-123') && !p.err.includes('process-test-token-123'), 'token never logged');
  p.child.kill('SIGTERM'); assert.equal(await p.exited, 0);
});

test('real process: refuses to expose itself publicly without a token (exit 1, clear message)', { timeout: 30_000 }, async () => {
  const p = start({ HOST: '0.0.0.0', PORT: '0', YT_CLIPS_DATA_DIR: tmpDir(), YT_CLIPS_TOKEN: '' });
  const code = await p.exited; assert.notEqual(code, 0); assert.match(p.err, /YT_CLIPS_TOKEN/);
});
