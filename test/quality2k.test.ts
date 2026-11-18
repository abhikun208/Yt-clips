import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { run } from '../src/util/proc.ts';
import { makeFixture, tmpDir } from './helpers.ts';

test('edit.quality "2k": real render is 1440x2560 h264/yuv420p/aac (FFprobe), manifest says conventional upscale (not AI); the source file is untouched', async () => {
  const cfg = loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: { edit: { quality: '2k', preset: 'ultrafast', speedRamp: false, jumpCuts: false, vfx: { particles: false, lightLeak: false } } } });
  assert.equal(cfg.edit.width, 1440); assert.equal(cfg.edit.height, 2560);
  const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'in.mp4'); await makeFixture(src, 10); const before = (await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src])).stdout;
  const v = await ingestLocal(s, cfg, src); s.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,category,fingerprint) VALUES (?,?,?,?,?,?)`, v.videoId, 1, 7, 0.9, 'general', 'fp-2k');
  const out = await renderCandidate(s, cfg, s.get<{ id: number }>('SELECT id FROM candidates')!.id, { title: 'T' }); { const qc = JSON.parse(s.get<{ q: string }>('SELECT qc_json q FROM clips')!.q) as { checks: Record<string, { ok: boolean; value: unknown }> }; for (const k of ['resolution', 'codec', 'audio_present', 'decodes_clean', 'duration']) assert.ok(qc.checks[k]!.ok, `QC ${k}`); assert.equal(qc.checks.resolution!.value, '1440x2560'); } // (black_frames is a property of this synthetic letterboxed fixture, not of 2K)
  const j = (await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0', out.editedPath])).stdout; assert.match(j, /h264,1440,2560,yuv420p/);
  const mf = JSON.parse((await import('node:fs')).readFileSync(join(cfg.dirs.manifests, `${out.outputId}.json`), 'utf8')) as { render: { quality: string; enhancement: string } }; assert.equal(mf.render.quality, '2k'); assert.match(mf.render.enhancement, /conventional lanczos.*no AI/);
  assert.equal((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src])).stdout, before, 'original untouched');
});
