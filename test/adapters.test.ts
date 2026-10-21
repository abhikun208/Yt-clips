import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { parseYoutubeUrl, parseEntries, addYoutubeSource, pollSources } from '../src/sources/youtube.ts';
import { parseSttJson, transcribeVideo } from '../src/analysis/stt.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { testConfig, makeFixture, tmpDir } from './helpers.ts';

const small = { clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 2, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast' } };
function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return fn().finally(() => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}

test('YouTube URL validation: only https youtube hosts, safe ids, normalized', () => {
  assert.deepEqual(parseYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'), { kind: 'video', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(parseYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10').kind, 'video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/shorts/abcDEF12345').kind, 'video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/@owner').url, 'https://www.youtube.com/@owner/videos');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/playlist?list=PLabcdefghijk').kind, 'channel');
  for (const bad of ['http://youtube.com/@x', 'https://evil.com/@x', 'https://youtube.com.evil.com/@x', 'file:///etc/passwd', 'not a url', 'https://www.youtube.com/watch?v=a;rm -rf', 'https://www.youtube.com/results?search_query=x', 'https://www.youtube.com/@x/../../etc']) assert.throws(() => parseYoutubeUrl(bad), /.+/, bad);
});

test('sources need explicit authorization; adding is idempotent', () => {
  const s = new Store(':memory:');
  assert.throws(() => addYoutubeSource(s, 'https://www.youtube.com/@owner', false), /authorization required/);
  const a = addYoutubeSource(s, 'https://www.youtube.com/@owner', true); const b = addYoutubeSource(s, 'https://www.youtube.com/@owner/videos', true);
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true);
  assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM sources')!.n, 1);
});

test('yt-dlp JSON parsing drops malformed entries', () => {
  assert.deepEqual(parseEntries(JSON.stringify({ entries: [{ id: 'abcDEF12345', title: 'A', duration: 10 }, null, { id: 'x' }, { id: 'bad id!!!!!!' }, { title: 'noid' }] })), [{ id: 'abcDEF12345', title: 'A', duration: 10 }]);
});

test('channel polling with a fake yt-dlp: discovers new+backlog, bounded per poll, skips too-long, retries failures, never duplicates', { timeout: 200_000 }, async () => {
  const bin = tmpDir(); const fx1 = join(bin, 'f1.mp4'); const fx2 = join(bin, 'f2.mp4'); await makeFixture(fx1, 20); await makeFixture(fx2, 22);
  const entries = join(bin, 'entries.json');
  writeFileSync(entries, JSON.stringify({ entries: [{ id: 'newVIDEO001', title: 'New upload', duration: 30 }, { id: 'oldVIDEO002', title: 'Old backlog', duration: 40 }, { id: 'hugeVIDEO03', title: 'Too long', duration: 99999 }] }));
  writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh
case "$*" in *--dump-single-json*) cat "${entries}"; exit 0;; esac
[ -n "$FAKE_FAIL" ] && { echo "ERROR: boom" >&2; exit 1; }
for a in "$@"; do last="$a"; done; id="\${last##*v=}"; dir=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && dir="\${a%/*}"; prev="$a"; done
mkdir -p "$dir"; if [ "$id" = "newVIDEO001" ]; then cp "${fx1}" "$dir/$id.mp4"; else cp "${fx2}" "$dir/$id.mp4"; fi; echo "$dir/$id.mp4"
`); chmodSync(join(bin, 'yt-dlp'), 0o755);
  await withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => {
    const cfg = testConfig({ ...small, youtube: { maxPerPoll: 1, maxDurationMin: 180 } }); const s = new Store(cfg.dbPath);
    addYoutubeSource(s, 'https://www.youtube.com/@owner', true);
    const r1 = await pollSources(s, cfg);
    assert.equal(r1.discovered, 2); assert.equal(r1.skipped, 1); assert.equal(r1.downloaded, 1, 'bounded by maxPerPoll');
    assert.equal(s.get<{ status: string }>(`SELECT status FROM sources WHERE uri LIKE '%newVIDEO001'`)!.status, 'done', 'newest video first');
    assert.equal(s.get<{ status: string }>(`SELECT status FROM sources WHERE uri LIKE '%hugeVIDEO03'`)!.status, 'skipped');
    const r2 = await pollSources(s, cfg); assert.equal(r2.discovered, 0, 'no duplicates on re-poll'); assert.equal(r2.downloaded, 1, 'backlog drained gradually');
    assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM videos')!.n, 2);
    assert.equal((await pollSources(s, cfg)).downloaded, 0);
    assert.ok(!existsSync(join(cfg.dirs.tmp, 'dl', 'newVIDEO001.mp4')), 'download temp removed');
    // failures: retried up to jobMaxAttempts then marked failed
    s.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES ('youtube_video','https://www.youtube.com/watch?v=failVIDEO04','x',1,'pending','{"tries":0}')`);
    await withEnv({ FAKE_FAIL: '1' }, async () => { for (let i = 0; i < 4; i++) await pollSources(s, cfg); });
    assert.equal(s.get<{ status: string }>(`SELECT status FROM sources WHERE uri LIKE '%failVIDEO04'`)!.status, 'failed');
    s.close();
  });
  // unauthorized sources are never fetched
  await withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => {
    const cfg = testConfig(small); const s = new Store(cfg.dbPath);
    s.exec(`INSERT INTO sources(kind, uri, title, authorized, status) VALUES ('youtube_channel','https://www.youtube.com/@x/videos','x',0,'active')`);
    assert.deepEqual(await pollSources(s, cfg), { discovered: 0, downloaded: 0, failed: 0, skipped: 0 }); s.close();
  });
});

test('polling reports clearly when yt-dlp is missing', async () => {
  await withEnv({ PATH: '/nonexistent' }, async () => { const cfg = testConfig(small); const s = new Store(cfg.dbPath); assert.match((await pollSources(s, cfg)).error ?? '', /yt-dlp not installed/); s.close(); });
});

test('STT JSON parsing: validates, drops garbage, keeps real word timing', () => {
  const ok = parseSttJson('log line\n' + JSON.stringify({ language: 'hi', segments: [{ start: 1, end: 3, text: ' ye hai ', words: [{ start: 1, end: 1.5, word: 'ye' }, { start: 2, end: 1, word: 'bad' }, { start: 1.6, end: 2, word: 'hai' }] }, { start: 5, end: 4, text: 'reversed' }, { start: 6, end: 7, text: '   ' }] }));
  assert.equal(ok.cues.length, 1); assert.deepEqual(ok.cues[0]!.words!.map((w) => w.text), ['ye', 'hai']); assert.equal(ok.language, 'hi');
  const pretty = parseSttJson('loading model...\n{\n  "language": "en",\n  "segments": [\n    {"start": 1, "end": 2, "text": "hi"}\n  ]\n}\n');
  assert.equal(pretty.cues.length, 1, 'multi-line JSON after log lines is accepted'); assert.equal(parseSttJson('{"segments":[{"start":0,"end":1,"text":"a"}]}').cues.length, 1);
  assert.throws(() => parseSttJson('{"error":"faster_whisper_missing"}'), /faster_whisper_missing/);
  assert.throws(() => parseSttJson('not json'));
});

test('STT adapter end-to-end with a fake engine: sidecar written, word-timed captions rendered, manifest says measured; failures are non-fatal', { timeout: 200_000 }, async () => {
  const d = tmpDir(); const eng = join(d, 'fake-stt.sh');
  writeFileSync(eng, `#!/bin/sh\ncat <<'EOF'\n{"language":"hinglish","segments":[{"start":5,"end":9,"text":"ye secret ka raaz hai","words":[{"start":5,"end":5.6,"word":"ye"},{"start":5.7,"end":6.4,"word":"secret"},{"start":6.5,"end":7,"word":"ka"},{"start":7.1,"end":7.8,"word":"raaz"},{"start":7.9,"end":8.5,"word":"hai"}]}]}\nEOF\n`); chmodSync(eng, 0o755);
  await withEnv({ YT_CLIPS_STT_CMD: eng }, async () => {
    const cfg = testConfig(small); const s = new Store(cfg.dbPath); const src = join(d, 'v.mp4'); await makeFixture(src, 24);
    const r = await ingestLocal(s, cfg, src); await analyzeVideo(s, cfg, r.videoId);
    const v = s.get<{ path: string }>('SELECT path FROM videos')!; const side = v.path.replace(/\.[^.]+$/, '') + '.json';
    assert.ok(existsSync(side), 'sidecar transcript written by analyzer'); assert.equal(JSON.parse(readFileSync(side, 'utf8'))[0].words.length, 5);
    const cand = s.get<{ id: number }>("SELECT id FROM candidates WHERE transcript != '' ORDER BY score DESC") ?? s.get<{ id: number }>('SELECT id FROM candidates')!;
    const out = await renderCandidate(s, cfg, cand.id, { captionPreset: 'build-coral', zoom: false, glow: false });
    const man = JSON.parse(readFileSync(join(cfg.dirs.manifests, `${out.outputId}.json`), 'utf8'));
    assert.equal(out.qcPass, true); assert.equal(man.captions.preset, 'build-coral'); assert.equal(man.captions.wordTiming, 'measured', 'real per-word timing from the engine is used, not approximated');
    s.close();
  });
  // failing engines never break the pipeline
  for (const script of ['#!/bin/sh\necho not-json\n', '#!/bin/sh\nexit 3\n', '#!/bin/sh\necho \'{"error":"model_download_failed"}\'; exit 4\n']) {
    writeFileSync(eng, script); await withEnv({ YT_CLIPS_STT_CMD: eng }, async () => {
      const cfg = testConfig(small); const src = join(d, 'w.mp4'); await makeFixture(src, 8);
      const t = await transcribeVideo(cfg, src); assert.equal(t.status, 'failed'); assert.ok(!existsSync(join(d, 'w.json')));
    });
  }
  await withEnv({ YT_CLIPS_STT_CMD: undefined }, async () => { const cfg = testConfig(small); assert.equal((await transcribeVideo(cfg, join(d, 'v.mp4'))).status, 'unavailable'); });
});
