import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { reframeParts } from '../src/edit/filters.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';

const o = (tiles?: { cx: number }[]) => ({ inW: 1280, inH: 720, outW: 1080, outH: 1920, reframe: 'multi_stack' as const, ...(tiles ? { tiles } : {}) });

test('multi_stack: 2 and 3 tiles render to exactly 1080x1920 with real ffmpeg', { timeout: 120_000 }, async () => {
  const d = tmpDir(); const src = join(d, 's.mp4');
  assert.equal((await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=10:d=1', '-pix_fmt', 'yuv420p', src], { timeoutMs: 30000 })).code, 0);
  for (const tiles of [[{ cx: 0.2 }, { cx: 0.8 }], [{ cx: 0.15 }, { cx: 0.5 }, { cx: 0.85 }]]) {
    const r = reframeParts(o(tiles)); assert.match(r.treatments[0]!.detail, new RegExp(`multi-person stack: ${tiles.length} tiles`));
    const out = join(d, `o${tiles.length}.mp4`);
    const x = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex', `${r.parts.join(';')}`, '-map', '[base]', out], { timeoutMs: 60000 }); assert.equal(x.code, 0, x.stderr);
    const p = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { timeoutMs: 20000 }); assert.equal(p.stdout.trim(), '1080,1920');
  }
});

test('multi_stack: wrong tile count falls back to the old branches (never throws)', () => {
  for (const t of [undefined, [{ cx: 0.5 }], [{ cx: 0.1 }, { cx: 0.2 }, { cx: 0.3 }, { cx: 0.4 }]]) { const r = reframeParts(o(t)); assert.doesNotMatch(r.treatments[0]!.detail, /multi-person/); }
});

test('2k quality: 16:9 renders at 2560x1440 and 1:1 at 1440x1440 (conventional upscale)', async () => {
  const { withAspect } = await import('../src/edit/render.ts'); const { testConfig } = await import('./helpers.ts');
  const c = testConfig({ edit: { quality: '2k', width: 1440, height: 2560 } });
  assert.deepEqual([withAspect(c, '16:9').edit.width, withAspect(c, '16:9').edit.height], [2560, 1440]); assert.deepEqual([withAspect(c, '1:1').edit.width, withAspect(c, '1:1').edit.height], [1440, 1440]);
  const s = testConfig({}); assert.deepEqual([withAspect(s, '16:9').edit.width, withAspect(s, '16:9').edit.height], [1920, 1080]);
});
