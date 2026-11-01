import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, makeDraft, cli } from './capcut_helpers.ts';
import { parseTime, fmt, fmtCue } from '../src/capcut/time.ts';
import { openDraft, DraftError } from '../src/capcut/draft.ts';
import { parseCues, toSrt, toVtt } from '../src/capcut/subs.ts';
import { diagnose } from '../src/capcut/doctor.ts';

test('time parsing and formatting', () => {
  assert.equal(parseTime('1.5s'), 1_500_000); assert.equal(parseTime('1500ms'), 1_500_000); assert.equal(parseTime('1:30'), 90_000_000); assert.equal(parseTime('00:01:30.250'), 90_250_000); assert.equal(parseTime('-2s'), -2_000_000);
  assert.equal(fmt(3_723_500_000), '01:02:03.500'); assert.equal(fmtCue(1_500_000, ','), '00:00:01,500'); assert.throws(() => parseTime('abc'));
});
test('SRT / VTT round trip, tolerant of CRLF, BOM and dots', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nthere\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\nBye\r\n';
  const c = parseCues(srt); assert.equal(c.length, 2); assert.equal(c[0]!.text, 'Hello\nthere'); assert.equal(c[1]!.start, 3_000_000);
  assert.deepEqual(parseCues(toSrt(c)), c); assert.deepEqual(parseCues(toVtt(c)), c); assert.ok(toVtt(c).startsWith('WEBVTT'));
});
test('info / tracks / segments / media / subs list on a draft', () => {
  const r = tmp(); const { dir } = makeDraft(r);
  const i = cli(['info', dir, '--json']); assert.equal(i.code, 0); const s = JSON.parse(i.out); assert.equal(s.canvas.startsWith('1080x1920'), true); assert.equal(s.subtitles, 3); assert.equal(s.media, 1);
  assert.match(cli(['tracks', dir]).out, /video/); assert.match(cli(['segments', dir]).out, /1:1/); assert.match(cli(['media', dir]).out, /clip\.mp4/); assert.match(cli(['subs', dir]).out, /second line/);
});
test('safe write: backup is made, original indent kept, restore works', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); writeFileSync(f, JSON.stringify(JSON.parse(readFileSync(f, 'utf8')), null, 2)); const before = readFileSync(f, 'utf8');
  assert.equal(cli(['speed', dir, '1:1', '2']).code, 0); const after = readFileSync(f, 'utf8'); assert.notEqual(before, after); assert.ok(after.startsWith('{\n  "')); assert.ok(readdirSync(dir).some((n) => n.includes('.bak-')));
  assert.equal(cli(['restore', dir]).code, 0); assert.equal(readFileSync(f, 'utf8'), before); assert.ok(readdirSync(dir).some((n) => n.includes('.pre-restore-')));
  assert.ok(!readdirSync(dir).some((n) => n.includes('.tmp-')));
});
test('dry run writes nothing', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); const before = readFileSync(f, 'utf8'); const x = cli(['volume', dir, '1:1', '50%', '--dry-run']); assert.equal(x.code, 0); assert.match(x.out, /dry run/); assert.equal(readFileSync(f, 'utf8'), before);
});
test('encrypted and corrupt drafts are refused, never modified', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); writeFileSync(f, Buffer.from([0x8a, 0x13, 0x77, 0x01, 0xff, 0x00])); const x = cli(['info', dir]); assert.equal(x.code, 3); assert.match(x.err, /encrypted/i); assert.deepEqual([...readFileSync(f)], [0x8a, 0x13, 0x77, 0x01, 0xff, 0x00]);
  writeFileSync(f, '{"tracks": [ '); assert.throws(() => openDraft(dir), (e: unknown) => e instanceof DraftError && e.code === 'CORRUPT');
  assert.equal(cli(['info', join(r, 'nope')]).code, 3);
});
test('unknown fields survive an edit', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); const j = JSON.parse(readFileSync(f, 'utf8')); j.mystery = { keep: [1, 2, 3] }; j.tracks[0].segments[0].future_field = 'x'; writeFileSync(f, JSON.stringify(j));
  cli(['volume', dir, '1:1', '0.5']); const k = JSON.parse(readFileSync(f, 'utf8')); assert.deepEqual(k.mystery, { keep: [1, 2, 3] }); assert.equal(k.tracks[0].segments[0].future_field, 'x'); assert.equal(k.tracks[0].segments[0].volume, 0.5);
});
test('speed keeps source/target consistent and ripples; trim, split, move, delete, gaps', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); const J = () => JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(cli(['speed', dir, '1:1', '2']).code, 0); let s = J().tracks[0].segments[0]; assert.equal(s.speed, 2); assert.equal(s.target_timerange.duration, 3_000_000); assert.equal(s.source_timerange.duration, 6_000_000);
  assert.ok(J().materials.speeds.some((m: { speed: number }) => m.speed === 2));
  assert.equal(cli(['trim', dir, '1:1', '--head', '1s']).code, 0); s = J().tracks[0].segments[0]; assert.equal(s.source_timerange.start, 1_000_000); assert.equal(s.target_timerange.duration, 2_500_000);
  assert.equal(cli(['split', dir, '1:1', '1s']).code, 0); assert.equal(J().tracks[0].segments.length, 2); const [a, b] = J().tracks[0].segments; assert.equal(a.target_timerange.duration + b.target_timerange.duration, 2_500_000); assert.equal(b.target_timerange.start, a.target_timerange.duration); assert.notEqual(a.extra_material_refs[0], b.extra_material_refs[0]);
  assert.equal(cli(['move', dir, '1:2', '5s']).code, 0); assert.equal(J().tracks[0].segments[1].target_timerange.start, 5_000_000);
  assert.equal(cli(['gaps', dir, '--track', '1']).code, 0); assert.equal(J().tracks[0].segments[1].target_timerange.start, J().tracks[0].segments[0].target_timerange.duration);
  assert.equal(cli(['delete', dir, '1:2']).code, 0); assert.equal(J().tracks[0].segments.length, 1);
  assert.equal(J().duration, 5_800_000); assert.equal(cli(['speed', dir, '1:1', '0']).code, 1); assert.equal(cli(['trim', dir, '1:1', '--end', '99s']).code, 1);
});
test('volume accepts percent and rejects nonsense', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); assert.equal(cli(['volume', dir, '1:1', '150%']).code, 0); assert.equal(JSON.parse(readFileSync(f, 'utf8')).tracks[0].segments[0].volume, 1.5); assert.equal(cli(['volume', dir, '1:1', 'loud']).code, 1);
});
test('subtitles: set, replace, shift, stretch, delete, tidy, import and export', () => {
  const r = tmp(); const { dir } = makeDraft(r); const subs = () => JSON.parse(cli(['subs', dir, '--json']).out) as { n: number; start: number; end: number; text: string }[];
  cli(['subs', 'set', dir, '2', 'edited text']); assert.equal(subs()[1]!.text, 'edited text');
  assert.match(cli(['subs', 'replace', dir, 'HELLO', 'hi', '-i']).out, /1 subtitle/); assert.equal(subs()[0]!.text, 'hi world');
  cli(['subs', 'shift', dir, '1s']); assert.equal(subs()[0]!.start, 1_500_000); cli(['subs', 'shift', dir, '-1s']); assert.equal(subs()[0]!.start, 500_000);
  cli(['subs', 'stretch', dir, '2']); assert.equal(subs()[0]!.start, 1_000_000);
  cli(['subs', 'delete', dir, '3']); assert.equal(subs().length, 2);
  const srt = join(r, 'out.srt'); assert.equal(cli(['subs', 'export', dir, srt]).code, 0); const cues = parseCues(readFileSync(srt, 'utf8')); assert.equal(cues.length, 2); assert.equal(cues[0]!.text, 'hi world');
  const vtt = join(r, 'out.vtt'); cli(['subs', 'export', dir, vtt]); assert.ok(readFileSync(vtt, 'utf8').startsWith('WEBVTT'));
  writeFileSync(join(r, 'new.srt'), '1\n00:00:00,000 --> 00:00:01,000\nfresh\n\n2\n00:00:01,000 --> 00:00:02,000\nstart\n'); cli(['subs', 'import', dir, join(r, 'new.srt'), '--replace']); assert.deepEqual(subs().map((s) => s.text), ['fresh', 'start']);
  cli(['subs', 'import', dir, join(r, 'new.srt'), '--offset', '10s']); assert.equal(subs().length, 4); assert.equal(subs()[2]!.start, 10_000_000);
  const j = JSON.parse(readFileSync(join(dir, 'draft_content.json'), 'utf8')); for (const m of j.materials.texts) { const c = JSON.parse(m.content); assert.equal(c.styles[0].range[1], [...c.text].length); }
});
test('styles and templates can be saved and applied', () => {
  const r = tmp(); const { dir } = makeDraft(r); const env = { ...process.env, CAPCUT_HOME: join(r, 'home') }; process.env.CAPCUT_HOME = env.CAPCUT_HOME;
  const f = join(dir, 'draft_content.json'); const j = JSON.parse(readFileSync(f, 'utf8')); const m0 = j.materials.texts[0]; const c0 = JSON.parse(m0.content); c0.styles[0].size = 15; c0.styles[0].bold = true; m0.content = JSON.stringify(c0); writeFileSync(f, JSON.stringify(j));
  assert.equal(cli(['style', 'save', dir, 'big', '--sub', '1']).code, 0); assert.match(cli(['style', 'list']).out, /big/);
  assert.equal(cli(['style', 'apply', dir, 'big']).code, 0); for (const m of JSON.parse(readFileSync(f, 'utf8')).materials.texts) { const c = JSON.parse(m.content); assert.equal(c.styles[0].size, 15); assert.equal(c.styles[0].bold, true); }
  assert.equal(cli(['template', 'save', dir, 'tpl']).code, 0); const r2 = makeDraft(tmp(), 'other'); assert.equal(cli(['template', 'apply', r2.dir, 'tpl']).code, 0); assert.equal(cli(['style', 'apply', r2.dir, 'missing']).code, 1);
  assert.equal(cli(['style', 'remove', 'big']).code, 0); assert.doesNotMatch(cli(['style', 'list']).out, /big/);
  delete process.env.CAPCUT_HOME;
});
test('doctor finds seeded problems and fix repairs the safe ones', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); assert.equal(cli(['doctor', dir]).code, 0);
  const j = JSON.parse(readFileSync(f, 'utf8')); j.duration = 1; j.tracks[0].segments[0].source_timerange.duration = 123; j.tracks[0].segments[0].extra_material_refs.push('GHOST-ID'); j.materials.videos[0].path = join(r, 'gone.mp4'); const t = j.tracks.find((x: { type: string }) => x.type === 'text'); t.segments[1].target_timerange.start = t.segments[0].target_timerange.start + 100_000; writeFileSync(f, JSON.stringify(j));
  const codes = diagnose(JSON.parse(readFileSync(f, 'utf8'))).map((x) => x.code); for (const c of ['duration', 'speed-mismatch', 'dangling-ref', 'missing-media', 'overlap']) assert.ok(codes.includes(c), c + ' in ' + codes.join());
  assert.equal(cli(['doctor', dir]).code, 2); assert.match(cli(['fix', dir]).out, /fix\(es\)/); const left = diagnose(JSON.parse(readFileSync(f, 'utf8'))).map((x) => x.code); assert.ok(!left.includes('duration') && !left.includes('speed-mismatch') && !left.includes('dangling-ref')); assert.ok(left.includes('overlap') && left.includes('missing-media'));
});
test('unknown command and missing args give clean errors', () => {
  assert.equal(cli(['bogus']).code, 1); const x = cli(['speed']); assert.equal(x.code, 1); assert.match(x.err, /missing draft/); assert.ok(existsSync(tmp()));
});
