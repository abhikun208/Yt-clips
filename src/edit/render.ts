import { writeFileSync, existsSync, readdirSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { guessLanguage } from '../analysis/transcript.ts';
import { realHook } from '../seo/hook.ts';
import { transcribeVideo } from '../analysis/stt.ts';
import { isInterlaced, hasBurnedSubs } from './sourcecheck.ts';
import { ensureLocal } from '../storage/cloud.ts';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run, which } from '../util/proc.ts';
import { probe } from '../media/probe.ts';
import { loadTranscript } from '../analysis/transcript.ts';
import { buildStyledAss, type CaptionResult } from './captions.ts';
import { getPreset } from './captionPresets.ts';
import { fillPace, isPace } from './pace.ts';
import { applyCaptionLanguage, type CaptionTarget } from '../ai/translate.ts';
import { llmChain } from '../ai/settings.ts';
import { channelOfVideo } from '../channels.ts';
import { encodeArgs, withEncoderFallback } from '../media/encoder.ts';
import { cuesToSubtitles } from '../analysis/transcript.ts';
import { installedFonts } from '../util/fonts.ts';
import { pickPeaks } from './beats.ts';
import { planRamp, rampedDuration, remapCues, rampFilter, type Ramp } from './ramp.ts';
import { audioEnergy } from '../analysis/signals.ts';
import { findLut } from './vfx.ts';
import { planCuts, cutFilter, remapCuesCuts, type CutPlan } from './jumpcut.ts';
import { detectSilence } from '../analysis/signals.ts';
import { keyphrases } from '../seo/local.ts';
import { measureVisualChange } from './change.ts';
import { buildVideoGraph, type VideoGraphOpts, buildAudioGraph, treatmentCoverage, type Treatment } from './filters.ts';
import { qcClip } from './qc.ts';
import { shortHash } from '../util/hash.ts';
import { info, warn } from '../util/log.ts';
import { pickHook, prependHook } from './hookintro.ts';
import { narrate } from './narrate.ts';
import { pickMusicTrack } from './music.ts';
import { clipHash, hashSimilarity } from '../media/phash.ts';
import { checkDisk, freeMb } from '../util/disk.ts';
import { freeUpSpace } from '../util/cleanup.ts';

export interface RenderOptions { pace?: string; translateTo?: CaptionTarget; captionPreset?: string; title?: string | null; reframe?: 'crop' | 'fit_blur' | 'gamer_stack' | 'split_gameplay'; cta?: string | null; memeHook?: boolean; facecam?: { x: number; y: number; w: number; h: number }; zoom?: boolean; glow?: boolean; fade?: boolean; faceTrack?: boolean; captions?: boolean; beats?: boolean; speedRamp?: boolean; variant?: number; jumpCuts?: boolean; emphasisZoom?: boolean; vfx?: Partial<{ lut: boolean; grain: boolean; particles: boolean; lightLeak: boolean; flash: boolean; progress: boolean }> }

async function faceCenter(path: string, root: string): Promise<number | undefined> {
  if (!(await which('python3'))) return undefined;
  try {
    const r = await run('python3', ['-I', join(root, 'tools', 'face_center.py'), path, '12'], { timeoutMs: 60_000 });
    const j = JSON.parse(r.stdout.trim() || '{}') as { cx: number | null; faces: number };
    return j.cx !== null && j.cx !== undefined && j.faces >= 3 ? j.cx : undefined;
  } catch { return undefined; }
}

/** Speaker-follow keyframes (tools/face_track.py). Empty when OpenCV/faces are missing: the caller keeps the static/centre crop. */
async function faceTrack(path: string, root: string): Promise<[number, number][]> {
  if (!(await which('python3'))) return [];
  try { const r = await run('python3', ['-I', join(root, 'tools', 'face_track.py'), path, '5'], { timeoutMs: 4 * 60_000 }); const j = JSON.parse(r.stdout.trim() || '{}') as { track?: [number, number][]; faces?: number }; return (j.faces ?? 0) >= 8 && Array.isArray(j.track) && j.track.length >= 3 ? j.track : []; } catch { return []; }
}


/**
 * Render one candidate: (1) frame-accurate raw clip to raw_clips (original-resolution, unedited), (2) edited short to NEW edited_shorts folder.
 * Originals are never touched. Output id is unique; existing outputs are never overwritten. Idempotent per candidate (resumes if clip row exists).
 */
export async function renderCandidate(store: Store, cfg: Config, candidateId: number, ro: RenderOptions = {}): Promise<{ clipId: number; outputId: string; editedPath: string; qcPass: boolean; reused: boolean }> {
  const c = store.get<{ id: number; video_id: number; start_sec: number; end_sec: number; category: string; status: string }>('SELECT id, video_id, start_sec, end_sec, category, status FROM candidates WHERE id=?', candidateId);
  if (!c) throw new Error(`Unknown candidate ${candidateId}`);
  const prior = ro.variant ? undefined : store.get<{ id: number; output_id: string; edited_path: string; qc_pass: number }>('SELECT id, output_id, edited_path, qc_pass FROM clips WHERE candidate_id=? AND variant=0', candidateId);
  if (prior && prior.edited_path && existsSync(prior.edited_path)) return { clipId: prior.id, outputId: prior.output_id, editedPath: prior.edited_path, qcPass: !!prior.qc_pass, reused: true };
  const v = store.get<{ path: string }>('SELECT path FROM videos WHERE id=?', c.video_id)!;
  await ensureLocal(store, cfg, v.path); // original may live in the cloud archive
  if (freeMb(cfg.dataDir) < cfg.resources.minFreeDiskMb) { const fr = freeUpSpace(store, cfg, cfg.resources.minFreeDiskMb + 200); if (fr.actions.length) warn('low disk: freed space', { freedMb: fr.freedMb, n: fr.actions.length }); }
  checkDisk(cfg.dataDir, cfg.resources.minFreeDiskMb);

  const dur = c.end_sec - c.start_sec;
  const baseId = `clip_${String(c.video_id).padStart(3, '0')}_${String(c.id).padStart(4, '0')}_${shortHash(`${v.path}:${c.start_sec}:${c.end_sec}`, 6)}`;
  const outputId = ro.variant ? `${baseId}_v${ro.variant}` : prior?.output_id ?? baseId;
  mkdirSync(cfg.dirs.rawClips, { recursive: true }); mkdirSync(cfg.dirs.editedShorts, { recursive: true });
  const rawPath = join(cfg.dirs.rawClips, `${baseId}.mp4`);
  const finalPath = join(cfg.dirs.editedShorts, `${outputId}.mp4`);
  if (existsSync(finalPath)) { // reached only when no finished clip row owns this file → a leftover of an interrupted attempt of ours (never a source/original): replace it
    if (store.get('SELECT 1 FROM clips WHERE edited_path=?', finalPath)) throw new Error(`Refusing to overwrite existing output ${finalPath}`);
    rmSync(finalPath, { force: true }); warn('removed stale output of an interrupted render', { file: finalPath });
  }
  const th = String(cfg.resources.ffmpegThreads);

  // 1) raw clip (frame-accurate: seek AFTER -i, re-encode)
  if (!existsSync(rawPath)) {
    const tmp = rawPath + '.part.mp4';
    const r = await withEncoderFallback(cfg, (enc) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-threads', th, '-i', v.path, '-ss', c.start_sec.toFixed(3), '-t', dur.toFixed(3), ...encodeArgs(enc, { crf: 17, preset: 'veryfast' }), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { timeoutMs: 20 * 60_000 }));
    let rr = r;
    if (rr.code !== 0 && /dav1d|av1|obu_|Failed to parse temporal|Invalid data/i.test(rr.stderr)) { // broken/unsupported AV1 decode (common on Termux/ARM builds): retry with the other decoder, then tolerate corrupt packets
      for (const pre of [['-c:v', 'libaom-av1'], ['-err_detect', 'ignore_err', '-fflags', '+discardcorrupt+genpts']]) {
        rmSync(tmp, { force: true });
        rr = await withEncoderFallback(cfg, (enc) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-threads', th, ...pre, '-i', v.path, '-ss', c.start_sec.toFixed(3), '-t', dur.toFixed(3), ...encodeArgs(enc, { crf: 17, preset: 'veryfast' }), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { timeoutMs: 20 * 60_000 }));
        if (rr.code === 0 && existsSync(tmp)) break;
      }
    }
    if (rr.code !== 0) throw new Error(`raw clip extraction failed (video may be AV1/corrupt — re-download it; new downloads avoid AV1): ${rr.stderr.slice(0, 300)}`);
    renameSync(tmp, rawPath);
  }
  const chan0early = channelOfVideo(store, c.video_id);
  const cleanFx = chan0early.config.effects === 'clean'; // owner/channel choice: dialogue/comedy content without film grain, dust, light leak, flash cuts, LUT, slow-mo
  let m = await probe(rawPath);
  // 1a) optional jump cuts: dead-air (long silences) removed; captions re-timed. Verified by duration, else rendered without.
  let cuts: CutPlan | null = null; let srcPath = rawPath; let cutNote = 'disabled'; const tmpFiles: string[] = [];
  if ((ro.jumpCuts ?? cfg.edit.jumpCuts) && m.hasAudio) {
    try {
      cuts = planCuts(await detectSilence(rawPath, -35, 0.55), m.duration); cutNote = cuts ? '' : 'no long silences / clip too short';
      if (cuts) {
        const cp = join(cfg.dirs.tmp, `${outputId}.cut.mp4`); tmpFiles.push(cp);
        const cr = await withEncoderFallback(cfg, (enc) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-threads', th, '-i', rawPath, '-filter_complex', cutFilter(cuts!, true), '-map', '[v]', '-map', '[a]', ...encodeArgs(enc, { crf: 16, preset: 'veryfast' }), '-c:a', 'aac', '-b:a', '192k', cp], { timeoutMs: 20 * 60_000 }));
        if (cr.code !== 0) { cuts = null; cutNote = 'ffmpeg cut failed; rendered without'; } else {
          const mc = await probe(cp); if (Math.abs(mc.duration - (m.duration - cuts.saved)) > 0.6) { cuts = null; cutNote = 'cut duration mismatch; rendered without'; } else { srcPath = cp; m = mc; }
        }
      }
    } catch { cuts = null; cutNote = 'jump-cut error; rendered without'; }
  }
  // 1b) optional slow-motion window at the strongest audio peak (re-timed clip; captions are re-timed to match)
  let ramp: Ramp | null = null; let editSrc = srcPath; let rampNote = 'disabled';
  if ((ro.speedRamp ?? (cleanFx ? false : cfg.edit.speedRamp)) && m.hasAudio) {
    try {
      const peaks = pickPeaks(await audioEnergy(srcPath, 0.25), { duration: m.duration, max: 1 }); ramp = planRamp(peaks[0], m.duration); rampNote = ramp ? '' : 'no strong peak / clip too short';
      if (ramp) {
        const rp = join(cfg.dirs.tmp, `${outputId}.ramp.mp4`);
        const rr = await withEncoderFallback(cfg, (enc) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-threads', th, '-i', srcPath, '-filter_complex', rampFilter(ramp!, true), '-map', '[v]', '-map', '[a]', ...encodeArgs(enc, { crf: 16, preset: 'veryfast' }), '-c:a', 'aac', '-b:a', '192k', rp], { timeoutMs: 20 * 60_000 }));
        if (rr.code !== 0) { ramp = null; rampNote = 'ffmpeg ramp failed; rendered without'; } else {
          const mr = await probe(rp); if (Math.abs(mr.duration - rampedDuration(m.duration, ramp)) > 0.5) { ramp = null; rampNote = 'ramped duration mismatch; rendered without'; rmSync(rp, { force: true }); } else { editSrc = rp; m = mr; }
        }
      }
    } catch { ramp = null; rampNote = 'ramp error; rendered without'; }
  }

  // 2) edit
  let cuesRaw = ro.captions === false ? [] : loadTranscript(v.path.replace(/\.[^.]+$/, ''));
  if (ro.captions !== false && cfg.stt.mode !== 'off' && !cuesRaw.some((q) => q.end > c.start_sec && q.start < c.end_sec)) {
    // The source was never transcribed (added before speech-to-text was available): transcribe just THIS clip (seconds, not hours) so captions are real, never invented.
    try {
      const sidecar = rawPath.replace(/\.[^.]+$/, ''); let rel = loadTranscript(sidecar);
      if (!rel.length) { const tr = await transcribeVideo(cfg, rawPath, { language: chan0early.config.language }); rel = tr.cues; if (tr.status === 'failed') warn('clip transcription failed', { clip: outputId, err: tr.error }); }
      cuesRaw = rel.map((q) => ({ ...q, start: q.start + c.start_sec, end: q.end + c.start_sec, ...(q.words ? { words: q.words.map((w) => ({ ...w, start: w.start + c.start_sec, end: w.end + c.start_sec })) } : {}) }));
    } catch (e) { warn('clip transcription error', { err: (e as Error).message.slice(0, 120) }); }
  } const cues0 = cuts ? remapCuesCuts(cuesRaw, c.start_sec, cuts) : cuesRaw;
  let cues = ramp ? remapCues(cues0, c.start_sec, ramp) : cues0; const effEnd = c.start_sec + m.duration;
  const chan0 = channelOfVideo(store, c.video_id); const toLang = ro.translateTo ?? chan0.config.translateTo ?? cfg.edit.captionLanguage ?? 'auto'; let translation: string | null = null;
  if (toLang && cues.length) { const tr = await applyCaptionLanguage(cues.filter((q) => q.end > c.start_sec && q.start < effEnd), toLang, chan0.config.language, llmChain(cfg)); if (tr.used) { cues = tr.cues; translation = `${toLang} via ${tr.used}`; } else if (tr.note) translation = `not translated: ${tr.note}`; }
  let assPath: string | undefined; let cap: CaptionResult | undefined;
  { const inClip = cues.filter((q) => q.end > c.start_sec && q.start < effEnd).map((q) => q.text).join(' ').trim();
    if (inClip) store.exec(`UPDATE candidates SET transcript=?, language=COALESCE(NULLIF(language,''),?) WHERE id=? AND (transcript IS NULL OR transcript='')`, inClip, guessLanguage(inClip), c.id); // so the metadata step works from the real speech
    if (ro.title === undefined && cfg.edit.hookTitle === true) { const h = realHook(inClip); if (h) ro = { ...ro, title: h }; } }
  { const pn = (c as { part_no?: number | null }).part_no, pt = (c as { part_total?: number | null }).part_total; // visible series label
    if (pn && pt) { const lbl = `PART ${pn}/${pt}`; ro = { ...ro, title: ro.title ? `${lbl} • ${ro.title}`.slice(0, 64) : lbl }; } }
  const presetId = ro.captionPreset ?? cfg.edit.captionPreset;
  const ctaText = ro.cta === undefined ? (chan0.config.cta ?? cfg.edit.cta ?? null) : ro.cta; // only what the owner set: no automatic extra text
  if (presetId !== 'none' && (cues.length || ro.title || ctaText)) {
    cap = buildStyledAss(cues, c.start_sec, effEnd, ro.title ?? null, { width: cfg.edit.width, height: cfg.edit.height, preset: presetId, emphasis: cfg.edit.captionEmphasis, cta: ctaText, resolveFont: (cands) => { const have = installedFonts(); return cands.find((x) => have.has(x.toLowerCase())); } });
    assPath = join(cfg.dirs.tmp, `${outputId}.ass`);
    writeFileSync(assPath, cap.ass, 'utf8');
  }
  if (cues.length && cfg.edit.exportSubtitles) {
    mkdirSync(join(cfg.dataDir, 'captions'), { recursive: true });
    writeFileSync(join(cfg.dataDir, 'captions', `${outputId}.srt`), cuesToSubtitles(cues, 'srt', c.start_sec, m.duration));
    writeFileSync(join(cfg.dataDir, 'captions', `${outputId}.vtt`), cuesToSubtitles(cues, 'vtt', c.start_sec, m.duration));
  }
  const chan = channelOfVideo(store, c.video_id); const facecam = ro.facecam ?? chan.config.facecam;
  let reframe: VideoGraphOpts['reframe'] = ro.reframe ?? (chan.config.layout === 'gamer_stack' && facecam ? 'gamer_stack' : chan.config.layout === 'split_gameplay' ? 'split_gameplay' : cfg.edit.reframe); let reframeNote = '';
  const fill = reframe === 'split_gameplay' ? pickFiller(cfg.dirs.assets, c.id) : null; if (reframe === 'split_gameplay' && !fill) { reframe = 'crop'; reframeNote = 'split_gameplay: assets/gameplay/ mein koi video nahi, normal crop use hua'; }
  if (reframe === 'crop' && !ro.reframe && chan.profile !== 'gaming' && m.width / m.height > 1.2 && await hasBurnedSubs(editSrc, 0, m.duration, cfg.dirs.tmp)) { reframe = 'fit_blur'; info('reframe switched', { why: 'burned-in subtitles' }); reframeNote = 'source has burned-in subtitles/text: fit + blurred background instead of a centre crop that cuts them'; }
  const deint = await isInterlaced(editSrc, 0, m.duration);
  const cx = reframe === 'crop' && ro.faceTrack !== false ? await faceCenter(editSrc, cfg.rootDir) : undefined;
  const ctrack = reframe === 'crop' && ro.faceTrack !== false && cfg.edit.speakerFollow !== false ? await faceTrack(editSrc, cfg.rootDir) : [];
  let punch: number[] = [];
  if ((ro.beats ?? cfg.edit.beatEffects) && m.hasAudio) { try { punch = pickPeaks(await audioEnergy(editSrc, 0.25), { duration: m.duration }); } catch { punch = []; } }
  let emph: string[] = [];
  if ((ro.emphasisZoom ?? cfg.edit.emphasisZoom) && cues.length) {
    try {
      const top = keyphrases(cues.map((x) => x.text).join(' '), 3).map((k) => k.phrase.split(' ')[0]!);
      const hits: number[] = []; for (const cu of cues) for (const w of cu.words ?? []) { const t = w.start - c.start_sec; if (top.includes(w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) && t > 0.6 && t < m.duration - 0.6 && hits.every((h) => Math.abs(h - t) > 2)) hits.push(t); }
      const extra = hits.filter((h) => punch.every((q) => Math.abs(q - h) > 1.2)).slice(0, 3); if (extra.length) { punch = [...punch, ...extra].sort((a, b) => a - b); emph = top; }
    } catch { emph = []; }
  }
  const paceMode = isPace(ro.pace) ? ro.pace : cfg.edit.pace; if (ro.beats !== false) punch = fillPace(punch, m.duration, paceMode);
  const musicPick = pickMusicTrack(cfg.dirs.assets, { mood: c.category, seed: c.id }); const music = musicPick?.path;
  const vg = buildVideoGraph({ punch,  inW: m.width, inH: m.height, outW: cfg.edit.width, outH: cfg.edit.height, fps: cfg.edit.fps, duration: m.duration, mood: c.category, reframe, fillIdx: fill ? (music && m.hasAudio ? 2 : 1) : undefined, facecam, cropXFrac: cx, cropTrack: ctrack.length ? ctrack : undefined, deinterlace: deint, assPath, fontsDir: join(cfg.dirs.assets, 'fonts'), zoom: ro.zoom ?? true, glow: ro.glow ?? true, fade: ro.fade ?? true,
    vfx: { ...cfg.edit.vfx, ...(cleanFx ? { lut: false, grain: false, particles: false, lightLeak: false, flash: false } : {}), ...(ro.vfx ?? {}), flashAt: [...punch.slice(0, 2), ...(ramp ? [ramp.a] : [])].sort((x, y) => x - y), lutFile: findLut(cfg.dirs.assets) } });
  const ag = buildAudioGraph({ hasAudio: m.hasAudio, targetLufs: cfg.edit.targetLufs, music: !!music && m.hasAudio, musicVolume: musicPick?.volume ?? cfg.edit.musicVolume, duration: m.duration });
  const filter = ag.graph ? `${vg.graph};${ag.graph}` : vg.graph;
  const argsFor = (enc: string) => ['-y', '-hide_banner', '-loglevel', 'error', '-threads', th, '-i', editSrc, ...(music && m.hasAudio ? ['-i', music] : []), ...(fill ? ['-stream_loop', '-1', '-i', fill] : []), '-filter_complex', filter, '-map', '[vout]', ...(ag.graph ? ['-map', '[aout]'] : []),
    '-r', String(cfg.edit.fps), ...encodeArgs(enc, { crf: cfg.edit.crf, preset: cfg.edit.preset }), ...(ag.graph ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : []), '-movflags', '+faststart', '-t', m.duration.toFixed(3), finalPath + '.part.mp4'];
  const r = await withEncoderFallback(cfg, (enc) => run('ffmpeg', argsFor(enc), { timeoutMs: 40 * 60_000 }));
  if (r.code !== 0) { rmSync(finalPath + '.part.mp4', { force: true }); throw new Error(`edit render failed: ${r.stderr.slice(0, 500)}`); }
  renameSync(finalPath + '.part.mp4', finalPath);

  let narrated = false; if ((chan0.config.narration ?? cfg.edit.narration) && ro.title && m.hasAudio) narrated = await narrate(finalPath, ro.title.replace(/#\w+/g, ''), cfg.dirs.tmp, { lang: (cfg.edit.captionLanguage === 'en' ? 'en' : 'hinglish') });
  // 3) QC (measured)
  let hookLen = 0; { const hk = (ro.memeHook ?? cfg.edit.memeHook) ? pickHook(cfg.dirs.assets, c.id) : null; if (hk && m.hasAudio) { try { hookLen = await prependHook(finalPath, hk, { width: cfg.edit.width, height: cfg.edit.height, fps: cfg.edit.fps }); info('meme hook prepended', { hook: hk.split('/').pop(), sec: hookLen }); } catch (e) { warn('meme hook skipped', { err: (e as Error).message.slice(0, 120) }); } } }
  const qc = await qcClip(finalPath, { width: cfg.edit.width, height: cfg.edit.height, duration: m.duration + hookLen, targetLufs: cfg.edit.targetLufs, requireAudio: m.hasAudio });
  const treatments: Treatment[] = [...vg.treatments, ...ag.treatments, cuts ? { dimension: 'jump_cuts', applied: true, detail: `${cuts.removed.length} dead-air gaps removed, ${cuts.saved.toFixed(1)}s saved; captions re-timed` } : { dimension: 'jump_cuts', applied: false, detail: cutNote }, { dimension: 'emphasis_zoom', applied: emph.length > 0, detail: emph.length ? `punch-zoom on keyword(s): ${emph.join(', ')}` : 'no keyword with measured word timing in this clip (or disabled)' }, ramp ? { dimension: 'speed_ramp', applied: true, detail: `slow-motion ${ramp.rate}x from ${ramp.a.toFixed(1)}s to ${ramp.b.toFixed(1)}s (audio atempo, captions re-timed); clip ${(m.duration).toFixed(1)}s` } : { dimension: 'speed_ramp', applied: false, detail: rampNote }];
  const cov = treatmentCoverage(treatments);
  let visualChange = null as Awaited<ReturnType<typeof measureVisualChange>>;
  try { visualChange = await measureVisualChange(editSrc, finalPath, { inW: m.width, inH: m.height, outW: cfg.edit.width, outH: cfg.edit.height, reframe, facecam, cropXFrac: cx }); } catch { visualChange = null; }
  const targetMet = cov.coverage >= cfg.edit.treatmentTarget;
  for (const f of [editSrc, srcPath, ...tmpFiles]) if (f !== rawPath) rmSync(f, { force: true });
  const manifest = {
    outputId, source: { videoId: c.video_id, path: v.path, start: c.start_sec, end: c.end_sec, candidateId }, rawClip: rawPath, edited: finalPath,
    captions: cap ? { preset: cap.presetId, label: getPreset(cap.presetId)?.label, wordTiming: cap.timing, font: cap.font, script: cap.script, warnings: cap.warnings } : null,
    render: { narration: narrated, width: cfg.edit.width, height: cfg.edit.height, fps: cfg.edit.fps, crf: cfg.edit.crf, preset: cfg.edit.preset, reframe, faceTracked: cx !== undefined, music: music ? { file: music.split('/').pop(), license: musicPick?.license ?? 'owner-supplied (licence not recorded)', source: musicPick?.source ?? null, moodMatched: musicPick?.matchedMood ?? false } : null },
    treatments, treatmentCoverage: cov, treatmentTarget: { target: cfg.edit.treatmentTarget, met: targetMet }, visualChange, translation, qc, createdAt: new Date().toISOString(),
  };
  const manifestPath = join(cfg.dirs.manifests, `${outputId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  rmSync(assPath ?? '', { force: true });
  const row = prior ? prior.id : store.exec('INSERT INTO clips(candidate_id, output_id, variant) VALUES (?,?,?)', candidateId, outputId, ro.variant ?? 0).lastId;
  store.exec(`UPDATE clips SET raw_path=?, edited_path=?, manifest_path=?, qc_json=?, qc_pass=?, state=? WHERE id=?`, rawPath, finalPath, manifestPath, JSON.stringify(qc), qc.pass ? 1 : 0, qc.pass ? 'QC_PASSED' : 'QC_FAILED', row);
  try { await dupCheck(store, cfg, row, c.id, finalPath, m.duration); } catch (e) { warn('duplicate check skipped', { err: (e as Error).message.slice(0, 80) }); }
  store.exec(`UPDATE candidates SET status='rendered' WHERE id=?`, candidateId);
  store.logState('clip', row, null, qc.pass ? 'QC_PASSED' : 'QC_FAILED', `coverage ${cov.applied}/${cov.total}`);
  if (!qc.pass) warn('QC failed', { outputId, failures: qc.failures }); else info('rendered', { outputId, coverage: cov.coverage, size: statSync(finalPath).size });
  return { clipId: row, outputId, editedPath: finalPath, qcPass: qc.pass, reused: false };
}

/** Owner's own filler footage for the split-screen layout: assets/gameplay/*. Deterministic per candidate (same clip → same filler). */
export function pickFiller(assetsDir: string, seed: number): string | null {
  const d = join(assetsDir, 'gameplay'); if (!existsSync(d)) return null;
  const fs = readdirSync(d).filter((x) => /\.(mp4|mov|mkv|webm)$/i.test(x)).sort(); return fs.length ? join(d, fs[seed % fs.length]!) : null;
}

/** Perceptual duplicate guard. ≥ dupBlock (default 0.93) similar to an earlier clip of another story → auto-rejected with a note (Restore undoes it); ≥ dupFlag (0.85) → note only. Parts of the same series are never compared with each other. */
export async function dupCheck(store: Store, cfg: Config, clipId: number, candidateId: number, file: string, duration: number): Promise<{ similarTo: number | null; sim: number }> {
  const h = await clipHash(file, duration); if (!h) return { similarTo: null, sim: 0 };
  store.exec('INSERT INTO clip_fingerprints(clip_id, hash) VALUES (?,?) ON CONFLICT(clip_id) DO UPDATE SET hash=excluded.hash', clipId, h);
  const me = store.get<{ series_key: string | null }>('SELECT series_key FROM candidates WHERE id=?', candidateId);
  let best = { id: 0, sim: 0 };
  for (const o of store.all<{ clip_id: number; hash: string; series_key: string | null; review: string }>(`SELECT f.clip_id, f.hash, cd.series_key, c.review FROM clip_fingerprints f JOIN clips c ON c.id=f.clip_id JOIN candidates cd ON cd.id=c.candidate_id WHERE f.clip_id<>? ORDER BY f.clip_id DESC LIMIT 400`, clipId)) {
    if (me?.series_key && o.series_key === me.series_key) continue;
    const sim = hashSimilarity(h, o.hash); if (sim > best.sim) best = { id: o.clip_id, sim };
  }
  const block = cfg.clip.dupBlock ?? 0.93, flag = cfg.clip.dupFlag ?? 0.85;
  if (best.sim >= block) store.exec(`UPDATE clips SET review='rejected', review_note=? WHERE id=? AND review='pending'`, `duplicate of clip #${best.id} (${Math.round(best.sim * 100)}% similar) — Restore karke rakh sakte ho`, clipId);
  else if (best.sim >= flag) store.exec(`UPDATE clips SET review_note=? WHERE id=? AND review_note IS NULL`, `possible duplicate of clip #${best.id} (${Math.round(best.sim * 100)}%)`, clipId);
  return { similarTo: best.sim >= flag ? best.id : null, sim: best.sim };
}
