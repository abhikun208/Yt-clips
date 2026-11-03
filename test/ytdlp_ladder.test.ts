import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadVideo } from '../src/sources/youtube.ts';
import { tmpDir } from './helpers.ts';

// fake yt-dlp: 403 on the default client and on tv_simply, success on android_vr; logs every call
function fake(dir: string, mode: 'ladder' | 'dns'): string {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true }); const log = join(dir, 'calls.log');
  writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh
echo "$@" >> ${log}
if [ "$1" = "--help" ]; then echo ""; exit 0; fi
${mode === 'dns' ? 'echo "ERROR: [Errno 7] No address associated with hostname" >&2; exit 1' : `case "$*" in *android_vr*) out=""; for a in "$@"; do case "$prev" in -o) out="$a";; esac; prev="$a"; done; f=$(echo "$out" | sed 's/%(id)s/vid/; s/%(ext)s/mp4/'); echo data > "$f"; echo "$f"; exit 0;; *) echo "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2; exit 1;; esac`}
`); chmodSync(join(bin, 'yt-dlp'), 0o755); return bin;
}
test('download retries other YouTube player clients after 403, and not after a DNS error', async () => {
  const d = tmpDir(); const bin = fake(d, 'ladder'); const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const p = await downloadVideo('https://www.youtube.com/watch?v=abcdefghijk', join(d, 'out'), 720);
    assert.match(p, /vid\.mp4$/); const calls = readFileSync(join(d, 'calls.log'), 'utf8').trim().split('\n'); assert.equal(calls.length, 3); assert.match(calls[2]!, /android_vr/);
    const d2 = tmpDir(); process.env.PATH = `${fake(d2, 'dns')}:${old}`;
    await assert.rejects(downloadVideo('https://www.youtube.com/watch?v=abcdefghijk', join(d2, 'out'), 720), /No address/);
    assert.equal(readFileSync(join(d2, 'calls.log'), 'utf8').trim().split('\n').length, 1);
  } finally { process.env.PATH = old; }
});
