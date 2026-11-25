import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { run } from '../src/util/proc.ts';
import { testConfig, tmpDir } from './helpers.ts';
import { CONTENT_TYPES } from '../src/analysis/contentdetect.ts';

async function setup(transcript: string, edit: Record<string, unknown> = {}, secs = 10) {
  const cfg = testConfig({ edit: { width: 270, height: 480, preset: 'ultrafast', speedRamp: false, jumpCuts: false, vfx: { particles: false, lightLeak: false }, ...edit } }); const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'r.mp4');
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=480x270:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src], { timeoutMs: 60_000 }); assert.equal(r.code, 0, r.stderr);
  const v = await ingestLocal(s, cfg, src); s.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,category,fingerprint,transcript) VALUES (?,?,?,?,?,?,?)`, v.videoId, 1, secs - 1, 0.9, 'general', 'fp-r', transcript);
  return { cfg, s, id: s.get<{ id: number }>('SELECT id FROM candidates')!.id };
}
const words = (t: string) => CONTENT_TYPES[t]!.words.slice(0, 8).join(' ');

const recipeOf = (st: Store, clipId: number) => (JSON.parse(readFileSync(st.get<{ manifest_path: string }>('SELECT manifest_path FROM clips WHERE id=?', clipId)!.manifest_path, 'utf8')) as { render: { recipe: { note: string; bRoll: string; faceOnScreen: boolean } | null } }).render.recipe;

test('render applies the detected content-type recipe and records it in the manifest', { timeout: 200_000 }, async () => {
  const { cfg, s, id } = await setup(words('podcast') + ' ' + words('podcast'));
  const out = await renderCandidate(s, cfg, id, { title: 'T' }); assert.ok(out.qcPass);
  const rc = recipeOf(s, out.clipId); assert.ok(rc, 'recipe recorded'); assert.match(rc!.note, /podcast/); assert.equal(rc!.bRoll, 'never');
});

test('edit.styleRecipes=false or ro.noRecipe -> no recipe at all (old behaviour)', { timeout: 200_000 }, async () => {
  const a = await setup(words('podcast') + ' ' + words('podcast'), { styleRecipes: false });
  assert.equal(recipeOf(a.s, (await renderCandidate(a.s, a.cfg, a.id, { title: 'T' })).clipId), null);
  const b = await setup(words('podcast') + ' ' + words('podcast'));
  assert.equal(recipeOf(b.s, (await renderCandidate(b.s, b.cfg, b.id, { title: 'T', noRecipe: true })).clipId), null);
});

test('hook teaser: payoff from the stored moment peak plays first (+1.5 s), skipped without a peak; off by default', { timeout: 300_000 }, async () => {
  const { teaserAt } = await import('../src/edit/teaser.ts'); const { probe } = await import('../src/media/probe.ts');
  assert.equal(teaserAt({ peakRel: undefined, outDur: 30 }), null); assert.equal(teaserAt({ peakRel: 2, outDur: 30 }), null); assert.equal(teaserAt({ peakRel: 29, outDur: 30 }), null); assert.equal(teaserAt({ peakRel: 12, outDur: 30 }), 11.6);
  const mk = async (edit: Record<string, unknown>, peak: number | null) => { const x = await setup('', edit); if (peak !== null) x.s.exec(`INSERT INTO moments(video_id,candidate_id,origin,start_sec,end_sec,peak_at,tier,score,confidence,breakdown_json,missing_json,reasons_json,fingerprint) VALUES (1,?,'moment',1,60,?,'STRONG',0.6,0.8,'{}','[]','[]','fp-t')`, x.id, peak); return x; };
  const dur = async (x: Awaited<ReturnType<typeof setup>>, ro: Record<string, unknown> = {}) => { const o = await renderCandidate(x.s, x.cfg, x.id, { title: 'T', noRecipe: true, ...ro }); return { d: (await probe(o.editedPath)).duration, qc: o.qcPass, man: JSON.parse(readFileSync((x.s.get<{ manifest_path: string }>('SELECT manifest_path FROM clips WHERE id=?', o.clipId))!.manifest_path, 'utf8')).render.hookTeaser as string | null }; };
  void dur; void mk; // the 10 s fixture is too short for a teaser (needs >= 4 s lead-in and 1.5 s tail) -> the render must say so and stay unchanged
  const a = await mk({ hookTeaser: true }, 5); const r = await dur(a); assert.ok(r.qc); assert.ok(r.d < 8.6, `duration unchanged ${r.d}`); assert.match(String(r.man), /no usable|teaser/);
  const b = await mk({}, 5); assert.equal((await dur(b)).man, null);
});

test('hook teaser positive path: a long clip with a stored peak gets a +1.5 s payoff intro and passes QC', { timeout: 600_000 }, async () => {
  const { probe } = await import('../src/media/probe.ts'); const x = await setup('', { hookTeaser: true }, 32);
  x.s.exec(`INSERT INTO moments(video_id,candidate_id,origin,start_sec,end_sec,peak_at,tier,score,confidence,breakdown_json,missing_json,reasons_json,fingerprint) VALUES (1,?,'moment',1,31,13,'STRONG',0.6,0.8,'{}','[]','[]','fp-pos')`, x.id);
  const o = await renderCandidate(x.s, x.cfg, x.id, { title: 'T', noRecipe: true }); assert.ok(o.qcPass);
  const man = JSON.parse(readFileSync(x.s.get<{ manifest_path: string }>('SELECT manifest_path FROM clips WHERE id=?', o.clipId)!.manifest_path, 'utf8')); assert.match(man.render.hookTeaser, /plays first \(1\.5s\)/);
  const y = await setup('', {}, 32); const p = await renderCandidate(y.s, y.cfg, y.id, { title: 'T', noRecipe: true });
  const dt = (await probe(o.editedPath)).duration - (await probe(p.editedPath)).duration; assert.ok(Math.abs(dt - 1.5) < 0.25, `teaser adds ~1.5 s, got ${dt}`);
});
