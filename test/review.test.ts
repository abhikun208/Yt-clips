import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { makeThumbnail } from '../src/seo/thumbnail.ts';
import { buildMetadata } from '../src/seo/metadata.ts';
import { reviewClip, editClipMeta, rerenderClip, exportPackage, setThumbnailFrame } from '../src/review/review.ts';
import { writeZip } from '../src/review/zip.ts';
import { automationTick } from '../src/publish/service.ts';
import { run } from '../src/util/proc.ts';
import { testConfig, makeFixture, tmpDir } from './helpers.ts';

const small = { edit: { width: 270, height: 480, preset: 'ultrafast', speedRamp: false, jumpCuts: false, vfx: { particles: false, lightLeak: false } } };
async function setup() {
  const cfg = testConfig(small); const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'in.mp4'); await makeFixture(src, 10);
  const r = await ingestLocal(s, cfg, src); s.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,category,fingerprint) VALUES (?,?,?,?,?,?)`, r.videoId, 4, 12, 0.9, 'general', 'fp-rv');
  const cand = s.get<{ id: number }>('SELECT id FROM candidates')!; const out = await renderCandidate(s, cfg, cand.id, { title: 'Review me' });
  const md = buildMetadata({ transcript: 'Never invest without checking cash flow. Cash flow shows the real health of a company. Most beginners ignore it.', category: 'general', language: 'en' });
  const th = await makeThumbnail(out.editedPath, join(cfg.dirs.thumbnails, `${out.outputId}.jpg`), md.thumbnailText);
  s.exec('UPDATE clips SET metadata_json=?, thumbnail_path=? WHERE id=?', JSON.stringify(md), th?.path ?? null, out.clipId);
  return { cfg, s, out, cand };
}

test('zip writer produces a valid archive (real `unzip -t` / python zipfile check, crc ok)', async () => {
  const d = tmpDir(); const z = join(d, 'a.zip'); writeZip(z, [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.bin', data: Buffer.alloc(70000, 7) }]);
  const r = await run('python3', ['-I', '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(sorted(z.namelist()), z.read("a.txt"))', z]); assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /a\.txt.*hello/);
});

test('review workflow: approve/reject, edit metadata (validated), thumbnail frame, export package, re-render as NEW variant (original kept)', { timeout: 280_000 }, async () => {
  const { cfg, s, out } = await setup();
  assert.equal(s.get<{ review: string }>('SELECT review FROM clips WHERE id=?', out.clipId)!.review, 'pending');
  assert.equal(reviewClip(s, out.clipId, 'approve', 'looks good'), 'approved'); assert.equal(reviewClip(s, out.clipId, 'reject'), 'rejected'); assert.equal(reviewClip(s, out.clipId, 'approve'), 'approved');
  assert.throws(() => reviewClip(s, 9999, 'approve'), /Unknown clip/);
  const md = editClipMeta(s, out.clipId, { title: 'Cash flow ka asli sach #Shorts', tags: ['cashflow', 'investing'] }); assert.equal(md.title, 'Cash flow ka asli sach #Shorts');
  assert.throws(() => editClipMeta(s, out.clipId, { title: '' }), /invalid/); assert.equal((JSON.parse(s.get<{ metadata_json: string }>('SELECT metadata_json FROM clips WHERE id=?', out.clipId)!.metadata_json) as { edited: boolean }).edited, true);
  const t = await setThumbnailFrame(s, cfg, out.clipId, 2); assert.ok(t && existsSync(t));
  const x = exportPackage(s, cfg, out.clipId); assert.ok(existsSync(x.path)); assert.ok(x.files.includes('post.md') && x.files.some((f) => f.endsWith('.mp4')) && x.files.includes('title.txt'));
  const z = await run('python3', ['-I', '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read("title.txt").decode())', x.path]); assert.match(z.stdout, /Cash flow ka asli sach/);
  const before = readFileSync(out.editedPath).length;
  const v2 = await rerenderClip(s, cfg, out.clipId, { captionPreset: 'build-coral', vfx: { grain: false } });
  assert.notEqual(v2.outputId, out.outputId); assert.match(v2.outputId, /_v1$/); assert.equal(readFileSync(out.editedPath).length, before, 'previous output untouched');
  const rows = s.all<{ output_id: string; variant: number; metadata_json: string | null }>('SELECT output_id, variant, metadata_json FROM clips ORDER BY id'); assert.equal(rows.length, 2); assert.equal(rows[1]!.variant, 1); assert.ok(rows[1]!.metadata_json, 'metadata copied to the variant');
  const mf = JSON.parse(readFileSync(join(cfg.dirs.manifests, `${v2.outputId}.json`), 'utf8')) as { treatments: { dimension: string; applied: boolean }[]; captions: { preset: string } };
  assert.equal(mf.captions.preset, 'build-coral'); assert.equal(mf.treatments.find((q) => q.dimension === 'film_grain')!.applied, false);
});

test('automation honours review: rejected never auto-queued; with requireReview only approved clips are queued', { timeout: 280_000 }, async () => {
  const { cfg, s, out } = await setup(); s.exec('UPDATE clips SET qc_pass=1 WHERE id=?', out.clipId);
  cfg.automation.blockGenericMetadata = false; cfg.automation.autoQueue = true; cfg.automation.platforms = ['youtube_shorts'];
  reviewClip(s, out.clipId, 'reject'); let r = await automationTick(s, cfg); assert.equal(r.queued, 0, 'rejected clip not queued');
  reviewClip(s, out.clipId, 'reset'); cfg.automation.requireReview = true; r = await automationTick(s, cfg); assert.equal(r.queued, 0, 'pending clip waits for review');
  reviewClip(s, out.clipId, 'approve'); r = await automationTick(s, cfg); assert.equal(r.queued, 1, 'approved clip queued (still gated by publish gates)');
  assert.equal(s.get<{ n: number }>("SELECT count(*) n FROM uploads WHERE state='PUBLISHED'")!.n, 0);
});
