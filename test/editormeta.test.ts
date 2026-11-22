import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { editClipMeta, setThumbnailFrame, thumbCandidates, exportPackage } from '../src/review/review.ts';
import { fallbackMetaForClip, metaForClip } from '../src/seo/clipmeta.ts';
import { testConfig, makeFixture, tmpDir } from './helpers.ts';

const small = { edit: { width: 270, height: 480, preset: 'ultrafast', speedRamp: false, jumpCuts: false, vfx: { particles: false, lightLeak: false } } };
async function setup() {
  const cfg = testConfig(small); const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'in.mp4'); await makeFixture(src, 10);
  const r = await ingestLocal(s, cfg, src); s.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,category,fingerprint,transcript,language) VALUES (?,?,?,?,?,?,?,?)`, r.videoId, 2, 10, 0.9, 'general', 'fp-em', 'Never invest without checking cash flow. Cash flow shows the real health of a company. Most beginners ignore it completely.', 'en');
  const cand = s.get<{ id: number }>('SELECT id FROM candidates')!; const out = await renderCandidate(s, cfg, cand.id, { title: 'T' });
  s.exec('UPDATE clips SET metadata_json=NULL WHERE id=?', out.clipId); // the reported state: a rendered clip with no metadata at all
  return { cfg, s, out };
}

test('a clip with NO metadata gets a visible FALLBACK (never blank, never labelled AI); manual edit then saves and reloads', async () => {
  const { cfg, s, out } = await setup();
  const md = fallbackMetaForClip(s, cfg, out.clipId, 'provider down')!; assert.ok(md.title.length > 3 && md.description.length > 20 && md.tags.length > 0, 'fields populated');
  assert.match(String(md.generatedBy), /^FALLBACK/); assert.equal(md.generic, true);
  assert.equal(fallbackMetaForClip(s, cfg, out.clipId, 'again'), null, 'never overwrites existing metadata');
  editClipMeta(s, out.clipId, { title: 'Mera apna title', tags: ['cash flow', 'investing', 'cash flow'] });
  const back = JSON.parse(s.get<{ m: string }>('SELECT metadata_json m FROM clips WHERE id=?', out.clipId)!.m); assert.equal(back.title, 'Mera apna title'); assert.equal(back.edited, true);
});
test('regeneration keeps manual edits unless forced; forced replaces them', async () => {
  const { cfg, s, out } = await setup(); process.env.YT_CLIPS_VISION = '0';
  fallbackMetaForClip(s, cfg, out.clipId, 'x'); editClipMeta(s, out.clipId, { title: 'Mera edit kiya title' });
  await metaForClip(s, cfg, out.clipId, { notifyOwner: false });
  let m = JSON.parse(s.get<{ m: string }>('SELECT metadata_json m FROM clips WHERE id=?', out.clipId)!.m); assert.equal(m.title, 'Mera edit kiya title', 'edit survived'); assert.ok(m.suggested?.title, 'new text offered as suggestion');
  await metaForClip(s, cfg, out.clipId, { notifyOwner: false, force: true });
  m = JSON.parse(s.get<{ m: string }>('SELECT metadata_json m FROM clips WHERE id=?', out.clipId)!.m); assert.notEqual(m.title, 'Mera edit kiya title', 'forced regeneration replaced it');
});
test('thumbnail studio: real candidate frames; every pick is a new file and the previous thumbnail stays', async () => {
  const { cfg, s, out } = await setup(); fallbackMetaForClip(s, cfg, out.clipId, 'x');
  const fr = await thumbCandidates(s, cfg, out.clipId, 4); assert.ok(fr.length >= 3, 'frames extracted'); for (const f of fr) assert.ok(existsSync(join(cfg.dirs.thumbnails, f.file)));
  const a = await setThumbnailFrame(s, cfg, out.clipId, fr[0]!.at, 'Pehla'); await new Promise((r) => setTimeout(r, 5)); const b = await setThumbnailFrame(s, cfg, out.clipId, fr[1]!.at, 'Doosra');
  assert.ok(a && b && a !== b && existsSync(a) && existsSync(b), 'both versions exist'); assert.equal(s.get<{ t: string }>('SELECT thumbnail_path t FROM clips WHERE id=?', out.clipId)!.t, b);
});
test('export ZIP carries title/description/tags of the saved metadata', async () => {
  const { cfg, s, out } = await setup(); fallbackMetaForClip(s, cfg, out.clipId, 'x'); editClipMeta(s, out.clipId, { title: 'Zip title' });
  const x = exportPackage(s, cfg, out.clipId); for (const n of ['title.txt', 'description.txt', 'tags.txt', 'version.json']) assert.ok(x.files.includes(n), `${n} in ${JSON.stringify(x.files)}`); assert.ok(x.files.some((f: string) => f.endsWith('.mp4')));
});
test('metaForClip stores evidence labels (research) and offline suggestions are labelled UNAVAILABLE, never VERIFIED', async () => {
  const { cfg, s, out } = await setup(); process.env.YT_CLIPS_VISION = '0';
  await metaForClip(s, cfg, out.clipId, { notifyOwner: false, force: true });
  const m = JSON.parse(s.get<{ m: string }>('SELECT metadata_json m FROM clips WHERE id=?', out.clipId)!.m) as { research?: { topic: string; label: string }[] };
  assert.ok(m.research && m.research.length === 5, 'five labelled insights'); assert.ok(m.research.every((r) => ['VERIFIED_DATA', 'ESTIMATE', 'AI_GUESS', 'UNAVAILABLE'].includes(r.label)));
  assert.notEqual(m.research.find((r) => r.topic === 'title_text')!.label, 'VERIFIED_DATA');
});
