import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { realDeps } from '../src/watcher/live-monitor.ts';
import { testConfig, tmpDir } from './helpers.ts';

function fakeYtdlp(script: string): { restore: () => void; log: string } {
  const dir = tmpDir(); const bin = join(dir, 'bin'); mkdirSync(bin); const log = join(dir, 'argv.log');
  writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh\necho "$@" >> "${log}"\n${script}\n`); chmodSync(join(bin, 'yt-dlp'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`; return { restore: () => { process.env.PATH = old; }, log };
}

test('regression: the live probe uses the downloader\'s extra args (cookies/runtime), retries another player client on bot-check, and tells "offline" from "error"', async () => {
  const cfg = testConfig(); process.env.YT_DLP_EXTRA_ARGS = '--proxy http://x:1';
  // 1st client: bot-check; 2nd client: live
  const f = fakeYtdlp(`if echo "$@" | grep -q player_client; then echo '{"is_live":true,"live_status":"is_live"}'; else echo "Sign in to confirm you're not a bot" >&2; exit 1; fi`);
  try {
    const p = await realDeps(cfg).probe('https://www.youtube.com/@ishowspeed/live');
    assert.equal(p.live, true); const argv = readFileSync(f.log, 'utf8'); assert.match(argv, /--proxy http:\/\/x:1/); assert.ok(argv.trim().split('\n').length >= 2, 'ladder retried');
  } finally { f.restore(); delete process.env.YT_DLP_EXTRA_ARGS; }
  const g = fakeYtdlp(`echo "ERROR: @ishowspeed is not currently live" >&2; exit 1`);
  try { const p = await realDeps(cfg).probe('u'); assert.deepEqual([p.live, !!p.error], [false, false]); } finally { g.restore(); }
  const h = fakeYtdlp(`echo "ERROR: This live event will begin in 2 hours" >&2; exit 1`);
  try { const p = await realDeps(cfg).probe('u'); assert.deepEqual([p.live, !!p.error], [false, false], 'upcoming stream = offline, not an error'); } finally { h.restore(); }
  const i = fakeYtdlp(`echo "Unable to download webpage: getaddrinfo failed" >&2; exit 1`);
  try { const p = await realDeps(cfg).probe('u'); assert.equal(p.error, true, 'network trouble is reported as an error'); } finally { i.restore(); }
  assert.ok(!existsSync('/nonexistent'));
});
