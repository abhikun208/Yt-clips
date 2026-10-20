import { writeFileSync, existsSync, readdirSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run, which } from '../util/proc.ts';
import { probe } from '../media/probe.ts';
import { loadTranscript } from '../analysis/transcript.ts';
import { buildAss } from './ass.ts';
import { buildVideoGraph, buildAudioGraph, treatmentCoverage, type Treatment } from './filters.ts';
import { qcClip } from './qc.ts';
import { shortHash } from '../util/hash.ts';
import { info, warn } from '../util/log.ts';
import { checkDisk } from '../util/disk.ts';

export interface RenderOptions { title?: string | null; reframe?: 'crop' | 'fit_blur'; zoom?: boolean; glow?: boolean; fade?: boolean; faceTrack?: boolean; captions?: boolean }

async function faceCenter(path: string, root: string): Promise<number | undefined> {
  if (!(await which('python3'))) return undefined;
  try {
    const r = await run('python3', ['-I', join(root, 'tools', 'face_center.py'), path, '12'], { timeoutMs: 60_000 });
    const j = JSON.parse(r.stdout.trim() || '{}') as { cx: number | null; faces: number };
    return j.cx !== null && j.cx !== undefined && j.faces >= 3 ? j.cx : undefined;
  } catch { return undefined; }
}

function pickMusic(assetsDir: string): string | undefined {
  const d = join(assetsDir, 'music');
  if (!existsSync(d)) return undefined;
  // Only files the owner placed there (must be licensed/authorized by them). Nothing is bundled.
  return readdirSync(d).filter((f) => /\.(mp3|wav|m4a|ogg)$/i.test(f)).map((f) => join(d, f))[0];
}

/**
 * Render one candidate: (1) frame-accurate raw clip to raw_clips (original-resolution, unedited), (2) edited short to NEW edited_shorts folder.
 * Originals are never touched. Output id is unique; existing outputs are never overwritten. Idempotent per candidate (resumes if clip row exists).
 */
export async function renderCandidate(store: Store, cfg: Config, candidateId: number, ro: RenderOptions = {}): Promise<{ clipId: number; outputId: string; editedPath: string; qcPass: boolean; reused: boolean }> {
  const c = store.get<{ id: number; video_id: number; start_sec: number; end_sec: number; category: string; status: string }>('SELECT id, video_id, start_sec, end_sec, category, status FROM candidates WHERE id=?', candidateId);
  if (!c) throw new Error(`Unknown candidate ${candidateId}`);
  const prior = store.get<{ id: number; output_id: string; edited_path: string; qc_pass: number }>('SELECT id, output_id, edited_path, qc_pass FROM clips WHERE candidate_id=?', candidateId);
  if (prior && prior.edited_path && existsSync(prior.edited_path)) return { clipId: prior.id, outputId: prior.output_id, editedPath: prior.edited_path, qcPass: !!prior.qc_pass, reused: true };
  const v = store.get<{ path: string }>('SELECT path FROM videos WHERE id=?', c.video_id)!;
  checkDisk(cfg.dataDir, cfg.resources.minFreeDiskMb);

  const dur = c.end_sec - c.start_sec;
  const outputId = prior?.output_id ?? `clip_${String(c.video_id).padStart(3, '0')}_${String(c.id).padStart(4, '0')}_${shortHash(`${v.path}:${c.start_sec}:${c.end_sec}`, 6)}`;
  mkdirSync(cfg.dirs.rawClips, { recursive: true }); mkdirSync(cfg.dirs.editedShorts, { recursive: true });
  const rawPath = join(cfg.dirs.rawClips, `${outputId}.mp4`);
  const finalPath = join(cfg.dirs.editedShorts, `${outputId}.mp4`);
  if (existsSync(finalPath)) throw new Error(`Refusing to overwrite existing output ${finalPath}`);
  const th = String(cfg.resources.ffmpegThreads);

  // 1) raw clip (frame-accurate: seek AFTER -i, re-encode)
  if (!existsSync(rawPath)) {
    const tmp = rawPath + '.part.mp4';
    const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-threads', th, '-i', v.path, '-ss', c.start_sec.toFixed(3), '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { timeoutMs: 20 * 60_000 });
    if (r.code !== 0) throw new Error(`raw clip extraction failed: ${r.stderr.slice(0, 300)}`);
    renameSync(tmp, rawPath);
  }
  const m = await probe(rawPath);

  // 2) edit
  const cues = ro.captions === false ? [] : loadTranscript(v.path.replace(/\.[^.]+$/, ''));
  let assPath: string | undefined;
  if (cues.length) {
    assPath = join(cfg.dirs.tmp, `${outputId}.ass`);
    writeFileSync(assPath, buildAss(cues, c.start_sec, c.end_sec, ro.title ?? null, { width: cfg.edit.width, height: cfg.edit.height, font: cfg.edit.font, highlight: '&H0000F0FF&', wordsPerChunk: 3 }), 'utf8');
  } else if (ro.title) {
    assPath = join(cfg.dirs.tmp, `${outputId}.ass`);
    writeFileSync(assPath, buildAss([], c.start_sec, c.end_sec, ro.title, { width: cfg.edit.width, height: cfg.edit.height, font: cfg.edit.font, highlight: '&H0000F0FF&', wordsPerChunk: 3 }), 'utf8');
  }
  const reframe = ro.reframe ?? cfg.edit.reframe;
  const cx = reframe === 'crop' && ro.faceTrack !== false ? await faceCenter(rawPath, cfg.rootDir) : undefined;
  const vg = buildVideoGraph({ inW: m.width, inH: m.height, outW: cfg.edit.width, outH: cfg.edit.height, fps: cfg.edit.fps, duration: m.duration, mood: c.category, reframe, cropXFrac: cx, assPath, fontsDir: join(cfg.dirs.assets, 'fonts'), zoom: ro.zoom ?? true, glow: ro.glow ?? true, fade: ro.fade ?? true });
  const music = pickMusic(cfg.dirs.assets);
  const ag = buildAudioGraph({ hasAudio: m.hasAudio, targetLufs: cfg.edit.targetLufs, music: !!music && m.hasAudio, duration: m.duration });
  const filter = ag.graph ? `${vg.graph};${ag.graph}` : vg.graph;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-threads', th, '-i', rawPath, ...(music && m.hasAudio ? ['-i', music] : []), '-filter_complex', filter, '-map', '[vout]', ...(ag.graph ? ['-map', '[aout]'] : []),
    '-r', String(cfg.edit.fps), '-c:v', 'libx264', '-preset', cfg.edit.preset, '-crf', String(cfg.edit.crf), '-pix_fmt', 'yuv420p', ...(ag.graph ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : []), '-movflags', '+faststart', '-t', m.duration.toFixed(3), finalPath + '.part.mp4'];
  const r = await run('ffmpeg', args, { timeoutMs: 40 * 60_000 });
  if (r.code !== 0) { rmSync(finalPath + '.part.mp4', { force: true }); throw new Error(`edit render failed: ${r.stderr.slice(0, 500)}`); }
  renameSync(finalPath + '.part.mp4', finalPath);

  // 3) QC (measured)
  const qc = await qcClip(finalPath, { width: cfg.edit.width, height: cfg.edit.height, duration: m.duration, targetLufs: cfg.edit.targetLufs, requireAudio: m.hasAudio });
  const treatments: Treatment[] = [...vg.treatments, ...ag.treatments, { dimension: 'speed_ramp', applied: false, detail: 'not implemented in this version' }, { dimension: 'beat_effects', applied: false, detail: 'not implemented in this version' }];
  const cov = treatmentCoverage(treatments);
  const manifest = {
    outputId, source: { videoId: c.video_id, path: v.path, start: c.start_sec, end: c.end_sec, candidateId }, rawClip: rawPath, edited: finalPath,
    render: { width: cfg.edit.width, height: cfg.edit.height, fps: cfg.edit.fps, crf: cfg.edit.crf, preset: cfg.edit.preset, reframe, faceTracked: cx !== undefined, music: music ? 'owner-supplied file' : null },
    treatments, treatmentCoverage: cov, qc, createdAt: new Date().toISOString(),
  };
  const manifestPath = join(cfg.dirs.manifests, `${outputId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  rmSync(assPath ?? '', { force: true });
  const row = prior ? prior.id : store.exec('INSERT INTO clips(candidate_id, output_id) VALUES (?,?)', candidateId, outputId).lastId;
  store.exec(`UPDATE clips SET raw_path=?, edited_path=?, manifest_path=?, qc_json=?, qc_pass=?, state=? WHERE id=?`, rawPath, finalPath, manifestPath, JSON.stringify(qc), qc.pass ? 1 : 0, qc.pass ? 'QC_PASSED' : 'QC_FAILED', row);
  store.exec(`UPDATE candidates SET status='rendered' WHERE id=?`, candidateId);
  store.logState('clip', row, null, qc.pass ? 'QC_PASSED' : 'QC_FAILED', `coverage ${cov.applied}/${cov.total}`);
  if (!qc.pass) warn('QC failed', { outputId, failures: qc.failures }); else info('rendered', { outputId, coverage: cov.coverage, size: statSync(finalPath).size });
  return { clipId: row, outputId, editedPath: finalPath, qcPass: qc.pass, reused: false };
}
