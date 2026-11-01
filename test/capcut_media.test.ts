import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, makeDraft, makeVideo, cli } from './capcut_helpers.ts';
import { probe, speechPieces } from '../src/capcut/media.ts';
import { pickWindows, evenWindows } from '../src/capcut/shorts.ts';
import { buildFfmpegArgs } from '../src/capcut/preview.ts';

test('probe and silence-based speech pieces', () => {
  const r = tmp(); const v = makeVideo(r); const p = probe(v); assert.ok(Math.abs(p.duration - 6e6) < 200_000); assert.equal(p.width, 640); assert.equal(p.hasAudio, true);
  const pcs = speechPieces(v, p.duration); assert.ok(pcs.length >= 2, JSON.stringify(pcs)); assert.ok(pcs[0]!.end <= 3_300_000 && pcs[1]!.start >= 3_800_000);
});
test('window picking never overlaps and respects min/max', () => {
  const ps = Array.from({ length: 30 }, (_, i) => ({ start: i * 3e6, end: i * 3e6 + 2.5e6, weight: i % 5 === 0 ? 1 : 3 })); const w = pickWindows(ps, { count: 3, min: 10e6, max: 20e6 });
  assert.equal(w.length, 3); for (const x of w) assert.ok(x.end - x.start >= 10e6 && x.end - x.start <= 20e6); for (let i = 1; i < w.length; i++) assert.ok(w[i]!.start >= w[i - 1]!.end);
  const e = evenWindows(100e6, { count: 4, min: 10e6, max: 20e6 }); assert.equal(e.length, 4); assert.ok(e[3]!.end <= 100e6);
});
test('shorts: one vertical draft per clip, subtitles sliced and retimed', () => {
  const r = tmp(); const v = makeVideo(r); const srt = join(r, 's.srt'); writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,000\nalpha\n\n2\n00:00:02,500 --> 00:00:04,000\nbeta\n\n3\n00:00:04,500 --> 00:00:05,800\ngamma\n');
  const out = join(r, 'shorts'); const x = cli(['shorts', v, '--mode', 'subs', '--subs', srt, '--count', '2', '--min', '1s', '--max', '1.6s', '--out', out, '--json']); assert.equal(x.code, 0, x.err); const res = JSON.parse(x.out) as { dir: string; start: number; end: number; subtitles: number }[]; assert.equal(res.length, 2);
  for (const s of res) { const j = JSON.parse(readFileSync(join(s.dir, 'draft_content.json'), 'utf8')); assert.equal(j.canvas_config.width, 1080); assert.equal(j.canvas_config.height, 1920); const seg = j.tracks[0].segments[0]; assert.equal(seg.source_timerange.start, s.start); assert.equal(seg.target_timerange.duration, s.end - s.start); assert.ok(seg.clip.scale.x > 1); assert.ok(existsSync(join(s.dir, 'draft_meta_info.json'))); assert.equal(cli(['doctor', s.dir]).code, 0); const subs = JSON.parse(cli(['subs', s.dir, '--json']).out) as { start: number; end: number }[]; assert.equal(subs.length, s.subtitles); for (const q of subs) assert.ok(q.start >= 0 && q.end <= s.end - s.start + 1); }
  const sil = cli(['shorts', v, '--mode', 'silence', '--count', '1', '--min', '1s', '--max', '3s', '--out', join(r, 'sh2')]); assert.equal(sil.code, 0, sil.err);
  assert.equal(cli(['shorts', v, '--mode', 'subs', '--out', out]).code, 1);
});
test('preview renders a playable file with speed, trim and subtitles', () => {
  const r = tmp(); const { dir } = makeDraft(r); cli(['speed', dir, '1:1', '2']); const o = join(r, 'p.mp4'); const x = cli(['preview', dir, '--out', o, '--height', '320']); assert.equal(x.code, 0, x.err); assert.ok(statSync(o).size > 5000);
  const p = probe(o); assert.ok(Math.abs(p.duration - 5.8e6) < 300_000, 'duration ' + p.duration); assert.equal(p.height, 320); assert.equal(p.hasAudio, true);
  const o2 = join(r, 'p2.mp4'); assert.equal(cli(['preview', dir, '--out', o2, '--from', '1s', '--to', '2s', '--no-subs']).code, 0); assert.ok(Math.abs(probe(o2).duration - 1e6) < 300_000);
});
test('preview reports missing media instead of failing silently', () => {
  const r = tmp(); const { dir } = makeDraft(r); const f = join(dir, 'draft_content.json'); const j = JSON.parse(readFileSync(f, 'utf8')); j.materials.videos[0].path = join(r, 'gone.mp4'); writeFileSync(f, JSON.stringify(j));
  const x = cli(['preview', dir, '--out', join(r, 'm.mp4')]); assert.match(x.out + x.err, /missing/); const a = buildFfmpegArgs(j, { out: 'x.mp4' }); assert.ok(a.notes.some((n) => /missing/.test(n)));
});
test('new draft from a video with subtitles', () => {
  const r = tmp(); const v = makeVideo(r); const x = cli(['new', 'mine', '--video', v, '--out', join(r, 'd')]); assert.equal(x.code, 0, x.err); const dir = x.out.trim().split(' ').slice(1).join(' ').trim(); assert.equal(cli(['doctor', dir]).code, 0); assert.match(cli(['info', dir]).out, /1080x1920/);
});
