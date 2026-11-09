import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJson3, fetchCaptions, captionSource } from '../src/sources/ytcaptions.ts';
import { loadTranscript } from '../src/analysis/transcript.ts';

const J3 = { events: [
  { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'haan', tOffsetMs: 0 }, { utf8: ' boliye', tOffsetMs: 600 }, { utf8: ' anjali', tOffsetMs: 1200 }] },
  { tStartMs: 3900, dDurationMs: 100, segs: [{ utf8: '\n' }] },
  { tStartMs: 4200, dDurationMs: 3000, segs: [{ utf8: '[Music]' }] },
  { tStartMs: 4500, dDurationMs: 3000, segs: [{ utf8: 'papad', tOffsetMs: 0 }, { utf8: ' ka', tOffsetMs: 500 }, { utf8: ' order', tOffsetMs: 900 }] },
  { tStartMs: 8000, dDurationMs: 2000, segs: [{ utf8: 'theek', tOffsetMs: 0 }, { utf8: ' hai', tOffsetMs: 700 }] },
] };

test('json3 -> cues with real per-word timing; music tags and newline events are dropped', () => {
  const c = parseJson3(JSON.stringify(J3));
  assert.equal(c.length, 3);
  assert.deepEqual(c[0]!.words!.map((w) => w.text), ['haan', 'boliye', 'anjali']);
  assert.equal(c[0]!.words![1]!.start, 0.6); assert.equal(c[0]!.words![0]!.end, 0.6);
  assert.equal(c[1]!.text, 'papad ka order'); assert.equal(c[1]!.start, 4.5);
  assert.deepEqual(parseJson3('not json'), []);
});

test('fetchCaptions writes the sidecar (preferring hi-orig, never a translation) and marks its origin; no track -> null', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ytcap-')), bin = mkdtempSync(join(tmpdir(), 'ytbin-'));
  const fake = join(bin, 'yt-dlp');
  writeFileSync(fake, `#!/bin/sh\nO=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && O="$2"; shift; done\nB="\${O%.%(ext)s}"\n[ -n "$FAKE_NONE" ] && exit 0\ncat > "$B.hi-orig.json3" <<'EOF2'\n${JSON.stringify(J3)}\nEOF2\ncat > "$B.en.json3" <<'EOF3'\n{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"english"}]}]}\nEOF3\n`);
  chmodSync(fake, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try {
    const base = join(d, 'vid');
    assert.equal(await fetchCaptions('https://youtu.be/x', base), 'hi-orig');
    assert.equal(captionSource(base), 'youtube-captions hi-orig');
    assert.equal(loadTranscript(base).length, 3);
    assert.deepEqual(readdirSync(d).filter((f) => f.endsWith('.json3')), []);          // temp files cleaned
    const none = join(d, 'other'); process.env.FAKE_NONE = '1';
    assert.equal(await fetchCaptions('https://youtu.be/y', none), null); assert.equal(existsSync(none + '.json'), false);
  } finally { process.env.PATH = oldPath; delete process.env.FAKE_NONE; }
});
