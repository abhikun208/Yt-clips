import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { probe } from '../media/probe.ts';
import { detectSilence, detectScenes, audioEnergy, detectBlack, normalizeEnergy } from './signals.ts';
import { detectBoundaries } from './boundaries.ts';
import { loadTranscript } from './transcript.ts';
import { selectCandidates } from './select.ts';
import { info } from '../util/log.ts';

export interface AnalysisFile {
  videoId: number; duration: number; introEnd: number; outroStart: number; boundaryReasons: string[];
  energyStep: number; energy: number[]; scenes: number[]; silence: { start: number; end: number }[]; hasTranscript: boolean; analyzedAt: string;
}

/** Analyze ENTIRE video, persist signals (resumable: skips if analysis file exists), then rank candidates. */
export async function analyzeVideo(store: Store, cfg: Config, videoId: number, o: { force?: boolean; override?: { introEnd?: number; outroStart?: number } } = {}): Promise<{ candidates: number; analysisPath: string }> {
  const v = store.get<{ path: string; state: string; analysis_path: string | null }>('SELECT path, state, analysis_path FROM videos WHERE id=?', videoId);
  if (!v) throw new Error(`Unknown video ${videoId}`);
  const analysisPath = v.analysis_path ?? join(cfg.dirs.manifests, `analysis_${videoId}.json`);
  const prev = v.state;
  store.exec(`UPDATE videos SET state='ANALYZING', updated_at=datetime('now') WHERE id=?`, videoId);
  try {
    let a: AnalysisFile;
    if (!o.force && existsSync(analysisPath)) {
      a = JSON.parse(readFileSync(analysisPath, 'utf8')) as AnalysisFile;
      info('analysis resumed from checkpoint', { videoId });
    } else {
      const m = await probe(v.path);
      const [silence, scenes, black, en] = await Promise.all([
        detectSilence(v.path), detectScenes(v.path), detectBlack(v.path), m.hasAudio ? audioEnergy(v.path, 0.5) : Promise.resolve({ step: 0.5, values: [] }),
      ]);
      const b = detectBoundaries(m.duration, { silence, black, scenes, introMaxSec: cfg.clip.introMaxSec, outroMaxSec: cfg.clip.outroMaxSec, override: o.override });
      const norm = normalizeEnergy(en);
      const cues = loadTranscript(v.path.replace(/\.[^.]+$/, ''));
      a = { videoId, duration: m.duration, introEnd: b.introEnd, outroStart: b.outroStart, boundaryReasons: b.reasons, energyStep: en.step, energy: norm, scenes, silence, hasTranscript: cues.length > 0, analyzedAt: new Date().toISOString() };
      writeFileSync(analysisPath, JSON.stringify(a));
    }
    const cues = loadTranscript(v.path.replace(/\.[^.]+$/, ''));
    const cands = selectCandidates({ videoKey: String(videoId), duration: a.duration, introEnd: a.introEnd, outroStart: a.outroStart, energy: a.energy, energyStep: a.energyStep, scenes: a.scenes, silence: a.silence, cues },
      { minSec: cfg.clip.minSec, maxSec: cfg.clip.maxSec, targetSec: cfg.clip.targetSec, maxClips: cfg.clip.maxClipsPerVideo, minScore: cfg.clip.minScore, maxOverlap: cfg.clip.maxOverlap });
    let inserted = 0;
    store.tx(() => {
      for (const c of cands) {
        const r = store.exec(
          `INSERT OR IGNORE INTO candidates(video_id, start_sec, end_sec, score, category, reason, hook, transcript, language, confidence, signals_json, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          videoId, c.start, c.end, c.score, c.category, c.reason, c.hook, c.transcript, c.language, c.confidence, JSON.stringify(c.signals), c.fingerprint!);
        inserted += r.changes;
      }
      store.exec(`UPDATE videos SET state='ANALYZED', intro_end=?, outro_start=?, analysis_path=?, error=NULL, updated_at=datetime('now') WHERE id=?`, a.introEnd, a.outroStart, analysisPath, videoId);
    });
    store.logState('video', videoId, prev, 'ANALYZED', `${cands.length} candidates, ${inserted} new (${basename(v.path)})`);
    return { candidates: cands.length, analysisPath };
  } catch (e) {
    store.exec(`UPDATE videos SET state='FAILED', error=?, updated_at=datetime('now') WHERE id=?`, (e as Error).message.slice(0, 500), videoId);
    throw e;
  }
}
