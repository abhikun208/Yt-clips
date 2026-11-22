import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adviseFraming, decide, pythonSampler, DEFAULT_GAMING_ZONES } from '../src/framing/advisor.ts';
import type { Sample, Face } from '../src/framing/plan.ts';
import { run, which } from '../src/util/proc.ts';

const f = (x: number): Face => ({ x, y: 0.3, w: 0.15, h: 0.25 });
const seq = (n: number, faces: Face[], t0 = 0): Sample[] => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 0.5, faces }));
const root = join(import.meta.dirname, '..');

test('advisor decide: no face (non-gaming) -> undefined (existing logic decides)', () => { assert.equal(decide(seq(20, []), { duration: 10 }), undefined); });
test('advisor decide: one face (non-gaming) -> undefined (existing speaker-follow handles it)', () => { assert.equal(decide(seq(20, [f(0.5)]), { duration: 10 }), undefined); });
test('advisor decide: two people close together -> crop centred between them; far apart -> fit_blur', () => {
  const near = decide(seq(20, [f(0.42), f(0.50)]), { duration: 10 })!; assert.equal(near.reframe, 'crop'); assert.ok(Math.abs(near.cropX! - 0.5) < 0.06);
  const far = decide(seq(20, [f(0.1), f(0.8)]), { duration: 10 })!; assert.equal(far.reframe, 'fit_blur'); assert.match(far.note, /instead of cutting someone/);
});
test('advisor decide: layout that keeps changing (1 person, then 2) -> fit_blur', () => {
  const s = [...seq(14, [f(0.5)]), ...seq(14, [f(0.1), f(0.4)], 7)]; const a = decide(s, { duration: 14 })!; assert.equal(a.reframe, 'fit_blur'); assert.match(a.note, /layout changes/);
});
test('advisor decide (gaming): no face -> centre crop that keeps minimap/kill feed/HUD whole; a protected region the window must cut -> fit_blur', () => {
  const a = decide(seq(20, []), { duration: 10, gaming: true })!; assert.equal(a.reframe, 'crop'); assert.ok(Math.abs(a.cropX! - 0.5) < 0.02);
  const wideHud = decide(seq(20, []), { duration: 10, gaming: true, protect: [...DEFAULT_GAMING_ZONES, { x: 0.25, y: 0.4, w: 0.5, h: 0.2 }] })!; assert.equal(wideHud.reframe, 'fit_blur'); assert.match(wideHud.note, /blur-fit|fit/);
});
test('advisor decide (gaming): protected zone would force the crop away from the people -> fit_blur, never cut a person', () => {
  const a = decide(seq(20, [f(0.42), f(0.50)]), { duration: 10, gaming: true, protect: [{ x: 0.2, y: 0.4, w: 0.2, h: 0.2 }] })!; assert.equal(a.reframe, 'fit_blur');
});
test('advisor: detector unavailable in every way -> undefined, never throws (existing behaviour preserved)', async () => {
  const mk = (sampler: () => Promise<Sample[] | null>) => adviseFraming({ src: 'x.mp4', rootDir: root, duration: 10, sampler });
  assert.equal(await mk(async () => null), undefined); assert.equal(await mk(async () => []), undefined);
  assert.equal(await mk(async () => { throw new Error('python crashed'); }), undefined);
  assert.equal(await mk(async () => seq(3, [f(0.2), f(0.8)])), undefined, 'fewer than 8 face samples is not evidence'); // 3 samples: too few
});
test('advisor with a fake sampler works (FAKE data: this is not real face detection)', async () => {
  const a = await adviseFraming({ src: 'x.mp4', rootDir: root, duration: 10, sampler: async () => seq(20, [f(0.1), f(0.8)]) }); assert.equal(a?.reframe, 'fit_blur');
});
test('real sidecar (tools/face_samples.py) on a real synthetic video: valid JSON; with no detector it reports an error and pythonSampler returns null', async (t) => {
  if (!(await which('ffmpeg')) || !(await which('python3'))) return t.skip('ffmpeg/python3 missing');
  const d = mkdtempSync(join(tmpdir(), 'fs-')); try {
    const v = join(d, 't.mp4'); await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=3', '-pix_fmt', 'yuv420p', '-y', v]);
    const r = await run('python3', ['-I', join(root, 'tools', 'face_samples.py'), v, '4'], { timeoutMs: 60_000 }); const j = JSON.parse(r.stdout.trim()) as { samples: unknown[]; faces: number; error?: string };
    assert.ok(Array.isArray(j.samples) && typeof j.faces === 'number');
    if (j.error) { assert.ok(['opencv_missing', 'no_detector', 'unreadable'].includes(j.error)); assert.equal(await pythonSampler(v, root), null); } else assert.equal(j.faces, 0, 'testsrc has no faces');
    console.log('# detector available in this environment:', !j.error, '(real face detection is NOT verified here when false)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
