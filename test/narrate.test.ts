import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { narrate, narrationGraph } from '../src/edit/narrate.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir, makeFixture } from './helpers.ts';

test('graph ducks original and delays narration', () => { const g = narrationGraph(3, 0.3, 0.25); assert.match(g, /volume=0.25:enable='between\(t,0.3,3.50\)'/); assert.match(g, /adelay=300\|300/); });

test('no TTS provider → clip untouched, returns false', async () => {
  const d = tmpDir(); const f = join(d, 'a.mp4'); await makeFixture(f, 6); const old = process.env.PATH; process.env.PATH = '/nonexistent-bin:/usr/bin:/bin'; delete process.env.PIPER_MODEL;
  try { const bin = (await run('sh', ['-c', 'command -v edge-tts'])).stdout.trim(); if (bin) return; assert.equal(await narrate(f, 'hello there', join(d, 'tts')), false); } finally { process.env.PATH = old; }
});

test('with a (stand-in) edge-tts the narration is mixed in, duration/video kept', async () => {
  const d = tmpDir(); const f = join(d, 'a.mp4'); await makeFixture(f, 10); const bin = join(d, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'edge-tts'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--write-media" ]; then O="$2"; fi; shift; done\nffmpeg -y -loglevel error -f lavfi -i "sine=frequency=880:duration=2" -q:a 4 "$O"\n`); chmodSync(join(bin, 'edge-tts'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const dur = async () => Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout.trim()); const before = await dur();
    assert.equal(await narrate(f, 'Ye dekho kya hua', join(d, 'tts')), true);
    assert.ok(Math.abs((await dur()) - before) < 0.6);
    const x = await run('ffmpeg', ['-ss', '4', '-t', '1', '-i', f, '-af', 'volumedetect', '-f', 'null', '-']); assert.ok(/mean_volume/.test(x.stderr));
  } finally { process.env.PATH = old; }
});

import { cleanConfig } from '../src/channels.ts';
test('channel config accepts cta/disclaimer/narration and rejects bad values', () => {
  const c = cleanConfig({ cta: 'SUBSCRIBE', disclaimer: 'Original commentary.', narration: true }, () => true); assert.equal(c.narration, true); assert.equal(c.disclaimer, 'Original commentary.');
  assert.throws(() => cleanConfig({ narration: 'yes' }, () => true)); assert.throws(() => cleanConfig({ disclaimer: 'x'.repeat(301) }, () => true));
});
