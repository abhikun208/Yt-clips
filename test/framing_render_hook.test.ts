import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, readdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { testConfig, makeFixture, tmpDir } from './helpers.ts';

const small = { clip: { minSec: 5, maxSec: 12, targetSec: 8, maxClipsPerVideo: 3, minScore: 0.2 }, edit: { width: 270, height: 480, preset: 'ultrafast', reframe: 'auto' } };
const real = process.cwd();
const FAR = JSON.stringify({ samples: Array.from({ length: 30 }, (_, i) => ({ t: i * 0.5, faces: [{ x: 0.08, y: 0.3, w: 0.15, h: 0.25, speaking: 0.5 }, { x: 0.77, y: 0.3, w: 0.15, h: 0.25, speaking: 0.1 }] })), faces: 60 });
const NODET = JSON.stringify({ samples: [], faces: 0, error: 'no_detector' });

/** root with the real assets/tools but a controllable tools/face_samples.py (the only file the advisor talks to) */
function fakeRoot(sampler: string): string {
  const d = mkdtempSync(join(tmpdir(), 'froot-')); for (const e of readdirSync(real)) if (e !== 'tools' && e !== 'data' && e !== 'node_modules') symlinkSync(join(real, e), join(d, e));
  cpSync(join(real, 'tools'), join(d, 'tools'), { recursive: true }); writeFileSync(join(d, 'tools', 'face_samples.py'), `import sys\nprint(${JSON.stringify(sampler)})\n`); return d;
}
async function renderWith(edit: Record<string, unknown>, sampler: string, gaming = false): Promise<{ reframe: string; detail: string; note: string }> {
  const cfg = testConfig({ ...small, edit: { ...small.edit, ...edit } }); (cfg as { rootDir: string }).rootDir = fakeRoot(sampler);
  const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'in.mp4'); await makeFixture(src, 24); const r = await ingestLocal(s, cfg, src); if (gaming) s.exec("UPDATE channels SET profile='gaming'"); await analyzeVideo(s, cfg, r.videoId);
  const cand = s.get<{ id: number }>('SELECT id FROM candidates ORDER BY score DESC')!; const out = await renderCandidate(s, cfg, cand.id, { title: 'T', zoom: false, glow: false, jumpCuts: false, speedRamp: false });
  const mp = s.get<{ manifest_path: string }>('SELECT manifest_path FROM clips WHERE id=?', out.clipId)!.manifest_path; const man = JSON.parse(readFileSync(mp, 'utf8')) as { treatments?: { dimension: string; detail: string }[] };
  const t = (man.treatments ?? []).find((x) => x.dimension === 'reframe_9x16'); s.close?.();
  return { reframe: t ? 'present' : 'missing', detail: t?.detail ?? '', note: JSON.stringify(man).match(/framing advisor[^"]*/)?.[0] ?? '' };
}

test('HOOK (real repo): flag unset == flag false == flag on + detector unavailable (existing behaviour preserved, no advisor note)', { timeout: 280_000 }, async () => {
  const a = await renderWith({}, FAR), b = await renderWith({ framingAdvisor: false }, FAR), c = await renderWith({ framingAdvisor: true }, NODET);
  assert.equal(a.note, '', 'flag unset: advisor never runs even if a detector would return faces'); assert.equal(b.note, ''); assert.equal(c.note, '', 'detector unavailable: no advisor decision');
  assert.deepEqual(a, b); assert.deepEqual(a, c); assert.equal(a.reframe, 'present');
});
const NEAR = JSON.stringify({ samples: Array.from({ length: 30 }, (_, i) => ({ t: i * 0.5, faces: [{ x: 0.40, y: 0.3, w: 0.15, h: 0.25, speaking: 0.5 }, { x: 0.50, y: 0.3, w: 0.15, h: 0.25, speaking: 0.1 }] })), faces: 60 });
test('HOOK (real repo): flag on + (FAKE) two close faces -> advisor switches the existing fit to a centred crop; far faces keep fit', { timeout: 280_000 }, async () => {
  const base = await renderWith({}, NEAR), near = await renderWith({ framingAdvisor: true }, NEAR), far = await renderWith({ framingAdvisor: true }, FAR);
  assert.notEqual(near.detail, base.detail, 'decision reached the filter graph'); assert.match(near.detail, /crop|fill|centre|center/i); assert.equal(far.detail, base.detail, 'far apart: fit stays');
  console.log('# base:', base.detail, '| near:', near.detail);
});

const NOFACE = JSON.stringify({ samples: Array.from({ length: 30 }, (_, i) => ({ t: i * 0.5, faces: [] })), faces: 0 });
test('HOOK gaming (real repo): no face + default HUD zones -> centred crop that keeps minimap/kill feed/HUD whole; a protected region no window can keep whole -> fit_blur; flag OFF unchanged', { timeout: 280_000 }, async () => {
  const off = await renderWith({}, NOFACE, true), safe = await renderWith({ framingAdvisor: true }, NOFACE, true), blocked = await renderWith({ framingAdvisor: true, gamingProtect: [{ x: 0.2, y: 0.4, w: 0.6, h: 0.2 }] }, NOFACE, true);
  assert.notEqual(safe.detail, off.detail, 'advisor decision reached the render'); assert.match(safe.detail, /center-crop|crop/i);
  assert.equal(blocked.detail, off.detail, 'unsafe crop falls back to the existing fit_blur picture'); assert.match(blocked.detail, /fit|blur/i);
  console.log('# gaming off:', off.detail, '| safe:', safe.detail, '| blocked:', blocked.detail);
});
