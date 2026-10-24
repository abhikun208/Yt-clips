import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, which } from '../src/util/proc.ts';
import { ocrLines, killfeedSeries, scanKillfeed } from '../src/analysis/killfeed.ts';
import { tmpDir } from './helpers.ts';
import { join } from 'node:path';

test('killfeed series: new OCR lines count as events, repeated/jittery lines do not', () => {
  assert.deepEqual(ocrLines('  \n!!\nPlayerOne  eliminated PlayerTwo\nab\n'), ['playerone eliminated playertwo']);
  const quiet = ['hud text stays here'], a = ['hud text stays here', 'alpha killed bravo'], jitter = ['hud text stays here', 'alpha kilied bravo'];
  const samples = [...Array(10).fill(quiet), a, jitter, jitter, quiet, quiet, quiet, quiet, quiet, quiet, ['hud text stays here', 'charlie knocked delta'], quiet, quiet];
  const s = killfeedSeries(samples as string[][], 2, 48)!;
  assert.ok(s, 'enough events'); assert.equal(s.values[Math.floor(20 / 5)], 1, 'first event at ~20s'); assert.ok(s.values[0]! === 0);
  assert.equal(killfeedSeries([quiet, quiet, quiet], 2, 6), null, 'no events => no signal');
});

test('REAL tesseract + ffmpeg: text appearing in the killfeed corner is detected at the right time', async (t) => {
  if (!(await which('tesseract'))) return t.skip('tesseract not installed');
  const dir = tmpDir(); const f = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const dt = (txt: string, a: number, b: number, y: number) => `drawtext=fontfile=${f}:text='${txt}':fontsize=44:fontcolor=white:box=1:boxcolor=black@0.7:x=w*0.64:y=${y}:enable='between(t,${a},${b})'`;
  const vid = join(dir, 'kf.mp4');
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x224422:s=1280x720:r=5:d=30,${dt('RAVEN eliminated ZED', 12, 15, 60)},${dt('NOVA knocked BLAZE', 22, 25, 120)}`, '-pix_fmt', 'yuv420p', vid], { timeoutMs: 60_000 });
  if (r.code !== 0) return t.skip('ffmpeg without drawtext/font: ' + r.stderr.slice(0, 80));
  const s = await scanKillfeed(vid, 30, dir, { step: 1 });
  assert.ok(s, 'series produced'); const peaks = s.values.map((v, i) => [v, i * s.step] as const).filter(([v]) => v > 0.5).map(([, ts]) => ts);
  assert.ok(peaks.some((p) => p >= 10 && p <= 15) && peaks.some((p) => p >= 20 && p <= 25), `peaks near 12-15s and 22-25s, got ${peaks}`);
  assert.ok(s.values.slice(0, 2).every((v) => v === 0), 'quiet start stays 0');
});
