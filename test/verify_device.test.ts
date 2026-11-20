import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { verifyDevice } from '../src/ops/verifyDevice.ts';
import { tmpDir } from './helpers.ts';

test('verify-device: reports measured facts only - never claims Termux off-device, FAILs on probe errors, SKIPs capture when not live, writes the report', async () => {
  const dir = tmpDir(); const bin = join(dir, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'yt-dlp'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi\necho "ERROR: @x is not currently live" >&2; exit 1\n'); chmodSync(join(bin, 'yt-dlp'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`; delete process.env.TERMUX_VERSION;
  try {
    const cfg = loadConfig(process.cwd(), { dataDir: dir }); const st = new Store(cfg.dbPath);
    st.exec(`INSERT INTO sources(kind, uri, authorized, status, meta_json) VALUES ('youtube_channel','https://www.youtube.com/@x/videos',1,'active',?)`, JSON.stringify({ watchLive: true }));
    const r = await verifyDevice(st, cfg, { capture: true });
    assert.equal(r.environment.termux, false, 'a sandbox run must never be labelled Termux');
    const by = (n: RegExp) => r.checks.find((c) => n.test(c.name))!;
    assert.equal(by(/^yt-dlp$/).status, 'PASS'); assert.equal(by(/^live probe/).status, 'PASS'); assert.match(by(/^live probe/).detail, /offline/); assert.equal(by(/^live capture/).status, 'SKIPPED');
    assert.equal(by(/^encode/).status, 'PASS'); assert.match(readFileSync(join(dir, 'device_verification.json'), 'utf8'), /"termux": false/);
  } finally { process.env.PATH = old; }
});
