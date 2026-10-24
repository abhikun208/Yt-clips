import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS, BASES, PALETTES, getPreset, detectScript, DEFAULT_PRESET } from '../src/edit/captionPresets.ts';
import { buildStyledAss, timeWords, assColor, pickFont } from '../src/edit/captions.ts';
import { buildAss } from '../src/edit/ass.ts';
import { cuesToSubtitles, parseSubtitles, type Cue } from '../src/analysis/transcript.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';

const words = 'Ye secret ka raaz kisi ko nahi pata tha yaar'.split(' ').map((w, i) => ({ start: 1 + i * 0.4, end: 1.35 + i * 0.4, text: w }));
const real: Cue[] = [{ start: 1, end: 5, text: words.map((w) => w.text).join(' '), words }];
const approx: Cue[] = [{ start: 1, end: 5, text: 'Ye secret ka raaz kisi ko nahi pata' }];
const O = { width: 540, height: 960 };

const events = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue: 0'));
const textOf = (e: string) => e.replace(/\{[^}]*\}/g, '').split(',').slice(9).join(',').trim();
const secs = (t: string) => { const [h, m, s] = t.split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };

test('preset registry: 72 unique original presets, valid palettes, default exists', () => {
  assert.equal(PRESETS.length, BASES.length * PALETTES.length); assert.ok(PRESETS.length >= 72);
  assert.equal(new Set(PRESETS.map((p) => p.presetId)).size, PRESETS.length);
  assert.ok(getPreset(DEFAULT_PRESET)); assert.equal(getPreset('nope'), undefined);
  for (const p of PALETTES) for (const k of ['base', 'active', 'upcoming', 'outline', 'box', 'emphasis'] as const) assert.match(p[k], /^#[0-9A-F]{6}$/);
  assert.equal(assColor('#FF8000'), '&H000080FF');
});

test('EVERY preset yields a well-formed ASS with ordered, positive-length events', () => {
  for (const p of PRESETS) {
    const r = buildStyledAss(real, 0, 6, 'Title', { ...O, preset: p.presetId });
    assert.equal(r.presetId, p.presetId); assert.equal(r.timing, 'measured');
    assert.match(r.ass, /\[V4\+ Styles\][\s\S]*Style: Cap,/); const ev = events(r.ass); assert.ok(ev.length >= (p.mode === 'karaoke' ? 2 : 5), p.presetId);
    for (const e of ev) { const f = e.split(','); assert.ok(secs(f[2]!) > secs(f[1]!), `${p.presetId}: ${e}`); }
  }
});

test('modes behave: build is cumulative, one-word shows single word, karaoke uses \\kf, type has no highlight colours', () => {
  const build = events(buildStyledAss(real, 0, 6, null, { ...O, preset: 'build-sun' }).ass);
  const firstChunk = build.slice(0, 4).map(textOf);
  assert.deepEqual(firstChunk, ['YE', 'YE SECRET', 'YE SECRET KA', 'YE SECRET KA RAAZ']);
  const one = events(buildStyledAss(real, 0, 6, null, { ...O, preset: 'one-word-sky' }).ass);
  assert.ok(one.every((e) => !textOf(e).includes(' ')), 'one word per event'); assert.equal(textOf(one[0]!), 'YE');
  assert.match(buildStyledAss(real, 0, 6, null, { ...O, preset: 'karaoke-gold' }).ass, /\{\\kf\d+\}/);
  assert.ok(!/\\c&H/.test(events(buildStyledAss(real, 0, 6, null, { ...O, preset: 'typewriter-mint' }).ass).join('\n')));
  const grey = buildStyledAss(real, 0, 6, null, { ...O, preset: 'build-grey-sun' }).ass;
  assert.ok(grey.includes('&H9A9A9A&'), 'upcoming words drawn grey');
});

test('word timing is reported honestly: measured vs approximate vs none', () => {
  assert.equal(buildStyledAss(real, 0, 6, null, O).timing, 'measured');
  assert.equal(buildStyledAss(approx, 0, 6, null, O).timing, 'approximate');
  const r = buildStyledAss([], 0, 6, 'Only Title', O); assert.equal(r.timing, 'none'); assert.equal(events(r.ass).length, 0); assert.match(r.ass, /Only Title/);
  const tw = timeWords(real, 2, 4); assert.ok(tw.words.every((w) => w.a >= 0 && w.b <= 2.0001), 'clipped & made relative to clip start');
});

test('hook words get emphasis colour; ASS-injection characters are stripped', () => {
  const ass = buildStyledAss([{ start: 0, end: 3, text: 'the secret {\\evil} is out' }], 0, 4, null, { ...O, preset: 'classic-sun' }).ass;
  assert.ok(!ass.includes('evil}') && !ass.includes('\\evil')); assert.ok(ass.includes('&H4D4DFF&'), 'emphasis (secret) coloured');
});

test('Indian scripts: detection, font choice, and a clear warning when no font is installed', () => {
  assert.equal(detectScript('यह एक राज़ है'), 'devanagari'); assert.equal(detectScript('hello world'), 'latin'); assert.equal(detectScript('தமிழ் உரை'), 'tamil'); assert.equal(detectScript('Aaj ka video यह'), 'latin', '<20% non-latin stays latin');
  const hi: Cue[] = [{ start: 0, end: 3, text: 'यह एक सच्चा राज़ है दोस्त' }];
  const ok = buildStyledAss(hi, 0, 4, null, { ...O, resolveFont: (c) => c.find((x) => x === 'FreeSans') });
  assert.equal(ok.script, 'devanagari'); assert.equal(ok.font, 'FreeSans'); assert.deepEqual(ok.warnings, []);
  const bad = buildStyledAss(hi, 0, 4, null, { ...O, resolveFont: () => undefined });
  assert.ok(bad.warnings.some((w) => /no installed font for devanagari/.test(w)));
  assert.equal(pickFont('latin').font, 'Poppins');
  assert.ok(buildStyledAss(real, 0, 6, null, { ...O, preset: 'does-not-exist' }).warnings.some((w) => /unknown caption preset/.test(w)));
});

test('legacy buildAss wrapper still works', () => {
  const ass = buildAss([{ start: 10, end: 12, text: 'hello world' }], 10, 20, 'My Title', { width: 540, height: 960, font: 'x', highlight: 'x', wordsPerChunk: 3 });
  assert.match(ass, /Dialogue: 0,0:00:00\.00/); assert.match(ass, /My Title/);
});

test('SRT/VTT export is relative to clip start and clipped; round-trips through the parser', () => {
  const cues: Cue[] = [{ start: 10, end: 12, text: 'one' }, { start: 30, end: 31, text: 'out' }];
  const srt = cuesToSubtitles(cues, 'srt', 10, 10); assert.match(srt, /00:00:00,000 --> 00:00:02,000\none/); assert.ok(!srt.includes('out'));
  const vtt = cuesToSubtitles(cues, 'vtt', 10, 10); assert.ok(vtt.startsWith('WEBVTT')); assert.match(vtt, /00:00:00\.000 --> 00:00:02\.000/);
  assert.equal(parseSubtitles(srt)[0]!.text, 'one');
});

test('REAL burn-in: one preset per mode renders visible captions via ffmpeg/libass', { timeout: 120_000 }, async () => {
  const dir = tmpDir();
  for (const id of ['classic-sun', 'build-coral', 'one-word-sky', 'karaoke-gold', 'chip-sun', 'glow-sky', 'typewriter-mint']) {
    const ass = join(dir, `${id}.ass`); writeFileSync(ass, buildStyledAss(real, 0, 6, null, { ...O, preset: id }).ass);
    const png = join(dir, `${id}.png`);
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x303845:s=540x960:r=15:d=6', '-vf', `subtitles=${ass}`, '-ss', '2.3', '-frames:v', '1', png]);
    assert.equal(r.code, 0, `${id}: ${r.stderr}`);
    const s = await run('ffmpeg', ['-hide_banner', '-i', png, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']);
    const ymax = Number(s.stdout.match(/YMAX=(\d+)/)?.[1] ?? 0); assert.ok(ymax > 120, `${id}: no visible caption pixels (ymax=${ymax})`);
  }
});

test('per-word font fallback: Latin words inside a Hindi clip get their own font tag; same-script words do not', () => {
  const cues = [{ start: 0, end: 3, text: 'यह बहुत headshot था', words: [{ text: 'यह', start: 0, end: .5 }, { text: 'बहुत', start: .5, end: 1 }, { text: 'headshot', start: 1, end: 2 }, { text: 'था', start: 2, end: 3 }] }];
  const resolve = (c: string[]) => c[0];
  const mixed = buildStyledAss(cues as never, 0, 3, null, { width: 1080, height: 1920, preset: 'classic-sun', resolveFont: resolve });
  assert.match(mixed.ass, /\{\\fn[^}]+\}headshot\{\\fn[^}]+\}/i, 'English word wrapped in its own \\fn');
  assert.ok(!/\{\\fn[^}]+\}(यह|बहुत|था)/.test(mixed.ass), 'dominant-script words keep the style font');
  const latin = buildStyledAss([{ start: 0, end: 2, text: 'one tap kill', words: [{ text: 'one', start: 0, end: .6 }, { text: 'tap', start: .6, end: 1.2 }, { text: 'kill', start: 1.2, end: 2 }] }] as never, 0, 2, null, { width: 1080, height: 1920, resolveFont: resolve });
  assert.ok(!/\\fn/.test(latin.ass.split('[Events]')[1]!), 'pure Latin clip needs no per-word override');
});
