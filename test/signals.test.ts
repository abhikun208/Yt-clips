import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveChat, chatSeries, parseHeatmap, heatSeries, externalBoost, gamingScore } from '../src/analysis/external.ts';
import { selectCandidates } from '../src/analysis/select.ts';

test('live chat + heatmap parsers, robust scaling, gaming vocabulary', () => {
  const lines: string[] = ['not json', '{"foo":1}']; for (let t = 0; t < 600; t += 2) lines.push(JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: String(t * 1000), actions: [] } }));
  for (let k = 0; k < 120; k++) lines.push(JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: String(300_000 + k * 40) } })); // burst at 300-305s
  const offs = parseLiveChat(lines.join('\n')); assert.equal(offs.length, 300 + 120);
  const cs = chatSeries(offs, 600)!; const peak = cs.values.indexOf(Math.max(...cs.values)); assert.equal(Math.floor(300 / 5), peak); assert.equal(cs.values[peak], 1); assert.ok(cs.values[10]! < 0.2);
  assert.equal(chatSeries(offs.slice(0, 5), 600), null, 'too little chat => no signal');
  const hm = parseHeatmap(JSON.stringify([{ start_time: 0, end_time: 30, value: 0.1 }, { start_time: 30, end_time: 60, value: 1 }, { start_time: 60, end_time: 90, value: 0.2 }, { start_time: 90, end_time: 120, value: 0.1 }, { bad: 1 }]));
  assert.equal(hm.length, 4); const hs = heatSeries(hm, 120)!; assert.equal(hs.values[7], 1); assert.equal(hs.values[1], 0.1);
  assert.ok(externalBoost([cs], 295, 320) > 0.7 && externalBoost([cs], 20, 45) < 0.3);
  assert.ok(gamingScore('arre booyah! headshot lagaya, 1v4 clutch') >= 1); assert.equal(gamingScore('aaj mausam accha hai'), 0); assert.ok(gamingScore('he is a skilled player') === 0, 'no substring false positives');
});

test('selection: a chat spike moves the picked clip to the reaction moment; gaming profile favours callouts', () => {
  const dur = 600, step = 0.5; const energy = new Array(dur / step).fill(0.3); const base = { videoKey: 'v', duration: dur, introEnd: 0, outroStart: dur, energy, energyStep: step, scenes: [] as number[], silence: [] as { start: number; end: number }[], cues: [] as never[] };
  const p = { minSec: 20, maxSec: 40, targetSec: 30, maxClips: 1, minScore: 0, maxOverlap: 0.2 };
  const flat = selectCandidates(base, p)[0]!;
  const series = [{ name: 'chat', step: 5, values: Array.from({ length: 120 }, (_, i) => (i >= 80 && i < 86 ? 1 : 0)) }];
  const boosted = selectCandidates({ ...base, external: series }, p)[0]!;
  assert.ok(boosted.start < 400 + 5 && boosted.end > 400, `clip ${boosted.start}-${boosted.end} covers the spike at 400-430s`); assert.ok(boosted.signals.external! > 0.5);
  assert.notEqual(flat.start, boosted.start);
});

import { reframeParts } from '../src/edit/filters.ts';
import { run } from '../src/util/proc.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.ts';
test('gamer_stack layout: gameplay on top, facecam rectangle fills the bottom (real ffmpeg, pixel check)', async () => {
  const fc = { x: 0.7, y: 0.65, w: 0.28, h: 0.3 }; // bottom-right facecam, drawn GREEN on a RED 1280x720 "stream"
  const rp = reframeParts({ inW: 1280, inH: 720, outW: 540, outH: 960, reframe: 'gamer_stack', facecam: fc });
  assert.match(rp.treatments[0]!.detail, /gamer stack/);
  const src = `color=c=red:s=1280x720:r=5:d=1,drawbox=x=${Math.round(1280 * fc.x)}:y=${Math.round(720 * fc.y)}:w=${Math.round(1280 * fc.w)}:h=${Math.round(720 * fc.h)}:color=green:t=fill`;
  const dir = tmpDir(); const out = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-filter_complex', `${rp.parts.join(';')};[base]scale=54:96,format=rgb24[o]`, '-map', '[o]', '-frames:v', '1', '-f', 'image2', '-c:v', 'ppm', join(dir, 'stack.ppm')], { timeoutMs: 30_000 }); assert.equal(out.code, 0, out.stderr);
  const buf = readFileSync(join(dir, 'stack.ppm')); const data = buf.subarray(buf.length - 54 * 96 * 3);
  const at = (x: number, y: number) => [data[(y * 54 + x) * 3]!, data[(y * 54 + x) * 3 + 1]!, data[(y * 54 + x) * 3 + 2]!];
  const top = at(27, 20), bot = at(27, 85); assert.ok(top[0]! > 200 && top[1]! < 60, `top should be red-ish gameplay: ${top}`); assert.ok(bot[1]! > 100 && bot[0]! < 60, `bottom should be green facecam: ${bot}`);
});
