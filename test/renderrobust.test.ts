import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { renderCandidate } from '../src/edit/render.ts';
import { probe } from '../src/media/probe.ts';
import { run } from '../src/util/proc.ts';
import { testConfig, tmpDir } from './helpers.ts';

// Source shaped like the ones that broke the mp4 header: 5.1 audio at 44.1 kHz + a second audio track + a subtitle-like data stream, odd video size.
test('render survives 5.1/44.1k multi-audio MKV with extra streams (stable mp4 header, stereo 48k AAC, h264 yuv420p)', async () => {
  const cfg = testConfig({ edit: { width: 270, height: 480, preset: 'ultrafast', speedRamp: false, jumpCuts: false, vfx: { particles: false, lightLeak: false } } }); const s = new Store(cfg.dbPath); const src = join(tmpDir(), 'odd.mkv');
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=478x270:rate=25:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=22050:duration=10',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-filter:a:0', 'pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src], { timeoutMs: 60_000 }); assert.equal(r.code, 0, r.stderr);
  const v = await ingestLocal(s, cfg, src); s.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,category,fingerprint) VALUES (?,?,?,?,?,?)`, v.videoId, 1, 9, 0.9, 'general', 'fp-odd');
  const cand = s.get<{ id: number }>('SELECT id FROM candidates')!; const out = await renderCandidate(s, cfg, cand.id, { title: 'T' });
  assert.ok(out.qcPass, 'QC passed'); const pr = await probe(out.editedPath); assert.equal(pr.width, 270); assert.equal(pr.height, 480);
  const j = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,channels,sample_rate', '-of', 'csv=p=0', out.editedPath]); assert.match(j.stdout, /h264,yuv420p/); assert.match(j.stdout, /aac,48000,2/);
});
