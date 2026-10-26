import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoGraph } from '../src/edit/filters.ts';
import { VFX_DEFAULTS } from '../src/edit/vfx.ts';
import { parseIdet } from '../src/edit/sourcecheck.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';
import { join } from 'node:path';

test('regression: glow/particles/light-leak screen blends no longer shift neutral footage toward magenta (chroma planes stay ~128)', async () => {
  const out = join(tmpDir(), 'o.mp4');
  for (const mood of ['aggressive', 'funny', 'neutral'] as const) {
    const g = buildVideoGraph({ inW: 1280, inH: 720, outW: 540, outH: 960, fps: 30, duration: 2, mood: mood as never, reframe: 'crop', zoom: false, glow: true, fade: false, vfx: { ...VFX_DEFAULTS, grain: false, flashAt: [] } }).graph;
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1280x720:r=30:d=2', '-filter_complex', g, '-map', '[vout]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { timeoutMs: 120_000 }); assert.equal(r.code, 0, r.stderr.slice(0, 300));
    const s = await run('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { timeoutMs: 60_000 });
    const u = [...s.stdout.matchAll(/UAVG=([\d.]+)/g)].map((x) => Number(x[1])), v = [...s.stdout.matchAll(/VAVG=([\d.]+)/g)].map((x) => Number(x[1]));
    const mu = u.reduce((a, b) => a + b, 0) / u.length, mv = v.reduce((a, b) => a + b, 0) / v.length;
    assert.ok(Math.abs(mu - 128) < 16 && Math.abs(mv - 128) < 16, `${mood}: U=${mu.toFixed(1)} V=${mv.toFixed(1)} (neutral grey must stay near 128)`);
  }
});
test('idet parsing: combed TV footage detected, progressive not', () => {
  assert.equal(parseIdet('Multi frame detection: TFF:   120 BFF:     0 Progressive:    10 Undetermined:     2'), true);
  assert.equal(parseIdet('Multi frame detection: TFF:     0 BFF:     0 Progressive:   150 Undetermined:     0'), false);
  assert.equal(parseIdet('nothing'), false);
});
import { buildStyledAss } from '../src/edit/captions.ts';
import { PRESETS, getPreset } from '../src/edit/captionPresets.ts';
test('caption templates: 280+ original presets render valid ASS; underline style sets the flag; amounts get the emphasis colour', () => {
  assert.ok(PRESETS.length >= 280); assert.equal(new Set(PRESETS.map((p) => p.presetId)).size, PRESETS.length);
  const cues = [{ start: 0, end: 3, text: 'quotation of Rs 16 lakh only', words: [{ start: 0, end: 0.6, text: 'quotation' }, { start: 0.6, end: 1, text: 'of' }, { start: 1, end: 1.4, text: 'Rs' }, { start: 1.4, end: 2, text: '16' }, { start: 2, end: 2.5, text: 'lakh' }, { start: 2.5, end: 3, text: 'only' }] }];
  for (const p of PRESETS) { const r = buildStyledAss(cues, 0, 3, null, { width: 1080, height: 1920, preset: p.presetId }); assert.ok(r.ass.includes('[Events]') && /Dialogue:/.test(r.ass), p.presetId); }
  const u = buildStyledAss(cues, 0, 3, null, { width: 1080, height: 1920, preset: 'underline-sun' }).ass; assert.match(u, /Style: Cap,[^,]*,\d+,[^,]*,[^,]*,[^,]*,[^,]*,-?1,0,-1,0,/);
  const e = buildStyledAss(cues, 0, 3, null, { width: 1080, height: 1920, preset: 'classic-sun' }).ass; const emph = getPreset('classic-sun')!.palette.emphasis.replace('#', '').toUpperCase(); assert.ok(e.toUpperCase().includes(emph.slice(4, 6) + emph.slice(2, 4) + emph.slice(0, 2)), 'emphasis colour (BGR) used for amounts');
});
