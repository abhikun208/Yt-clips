import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';
import { pollSources, addYoutubeSource } from '../src/sources/youtube.ts';
import { sourceSettings, cleanSettings, permanentReason } from '../src/sources/sourcecfg.ts';

test('sourceSettings: defaults = global values; input is clamped', () => {
  const cfg = testConfig(); const d = sourceSettings({}, cfg);
  assert.equal(d.perPoll, cfg.youtube.maxPerPoll); assert.equal(d.backlog, true); assert.equal(d.order, 'newest'); assert.equal(d.scanDepth, 30);
  assert.deepEqual(cleanSettings({ perPoll: 999, scanDepth: 1, order: 'x', evil: 1, backlog: false }), { perPoll: 20, scanDepth: 5, order: 'newest', backlog: false });
});
test('permanentReason: members-only/private/removed are permanent, network errors are not', () => {
  assert.match(permanentReason('ERROR: [youtube] X: Join this channel to get access to members-only content')!, /members-only/);
  assert.ok(permanentReason('This video is private')); assert.equal(permanentReason('Unable to download webpage: timed out'), null);
});

test('poll: members-only video is skipped at once (never blocks the queue); per-source perPoll=2 downloads 2; old videos are processed when nothing new', { timeout: 200_000 }, async () => {
  const bin = tmpDir(); const fx = join(bin, 'f.mp4'); await makeFixture(fx, 20); const fx2 = join(bin, 'g.mp4'); await makeFixture(fx2, 22); const fx3 = join(bin, 'h.mp4'); await makeFixture(fx3, 24);
  const entries = join(bin, 'e.json');
  writeFileSync(entries, JSON.stringify({ entries: [{ id: 'memberVID001', title: 'Members', duration: 30 }, { id: 'goodVIDEO002', title: 'Good A', duration: 30 }, { id: 'goodVIDEO003', title: 'Good B', duration: 30 }, { id: 'goodVIDEO004', title: 'Good C', duration: 30 }] }));
  writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh
case "$*" in *--dump-single-json*) cat "${entries}"; exit 0;; esac
for a in "$@"; do last="$a"; done; id="\${last##*v=}"
[ "$id" = "memberVID001" ] && { echo "ERROR: [youtube] $id: Join this channel to get access to members-only content like this video" >&2; exit 1; }
dir=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && dir="\${a%/*}"; prev="$a"; done
mkdir -p "$dir"; case "$id" in goodVIDEO002) cp "${fx}" "$dir/$id.mp4";; goodVIDEO003) cp "${fx2}" "$dir/$id.mp4";; *) cp "${fx3}" "$dir/$id.mp4";; esac; echo "$dir/$id.mp4"
`); chmodSync(join(bin, 'yt-dlp'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try {
    const cfg = testConfig({ youtube: { maxPerPoll: 1, maxDurationMin: 180 }, automation: { sequentialLock: false } }); /* no worker here: the default-on lock (test/sequential.test.ts) would hold videos back */ const s = new Store(cfg.dbPath);
    const { id } = addYoutubeSource(s, 'https://www.youtube.com/@owner', true);
    s.exec(`UPDATE sources SET meta_json=? WHERE id=?`, JSON.stringify({ perPoll: 2 }), id);
    const r1 = await pollSources(s, cfg);
    const st = (v: string) => s.get<{ status: string; meta_json: string }>(`SELECT status, meta_json FROM sources WHERE uri LIKE '%${v}'`)!;
    assert.equal(st('memberVID001').status, 'skipped'); assert.match(st('memberVID001').meta_json, /members-only/);
    assert.equal(r1.downloaded, 2, 'dead video did not use the quota; perPoll=2 of this source applied');
    const r2 = await pollSources(s, cfg); assert.equal(r2.downloaded, 1); assert.equal(st('goodVIDEO004').status, 'done');
    // nothing waiting + no new uploads -> it reaches further back (older page) instead of idling
    entries && writeFileSync(entries, JSON.stringify({ entries: [{ id: 'goodVIDEO004', title: 'Good C', duration: 30 }] }));
    s.exec(`UPDATE sources SET meta_json=? WHERE id=?`, JSON.stringify({ perPoll: 2, scanDepth: 5 }), id);
    const cnt = s.get<{ n: number }>('SELECT count(*) n FROM sources')!.n; await pollSources(s, cfg); assert.ok(s.get<{ v: string }>(`SELECT v FROM kv WHERE k=?`, `chfrom:${id}`), 'backlog page cursor advanced'); assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM sources')!.n, cnt);
    // backlog=false: old (non-fresh) pending videos are left alone
    s.exec(`INSERT INTO sources(kind, uri, title, authorized, status, meta_json) VALUES ('youtube_video','https://www.youtube.com/watch?v=oldVIDEO005','o',1,'pending',?)`, JSON.stringify({ channelSource: id, tries: 0, fresh: false }));
    s.exec(`UPDATE sources SET meta_json=? WHERE id=?`, JSON.stringify({ backlog: false }), id); await pollSources(s, cfg); assert.equal(st('oldVIDEO005').status, 'pending');
    s.exec(`UPDATE sources SET meta_json=? WHERE id=?`, JSON.stringify({}), id); await pollSources(s, cfg); assert.equal(st('oldVIDEO005').status, 'done');
    s.close();
  } finally { process.env.PATH = oldPath; }
});
