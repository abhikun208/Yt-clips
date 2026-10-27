import { channelOfVideo } from '../channels.ts';
import { loadExternalSeries } from './external.ts';
import { learnedCategoryPrior } from '../publish/service.ts';
import { scanKillfeed } from './killfeed.ts';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { probe } from '../media/probe.ts';
import { detectSilence, detectScenes, audioEnergy, detectBlack, normalizeEnergy } from './signals.ts';
import { detectBoundaries } from './boundaries.ts';
import { loadTranscript, textInRange, guessLanguage } from './transcript.ts';
import { sentencesFromCues, sentencesIn } from './textsignals.ts';
import { planSeries } from './series.ts';
import { shortHash } from '../util/hash.ts';
import { selectCandidates, overlapRatio } from './select.ts';
import { info, warn } from '../util/log.ts';
import { transcribeVideo } from './stt.ts';
import { rerankCandidates } from '../ai/rerank.ts';
import { llmChain } from '../ai/settings.ts';

export interface AnalysisFile {
  videoId: number; duration: number; introEnd: number; outroStart: number; boundaryReasons: string[];
  energyStep: number; energy: number[]; scenes: number[]; silence: { start: number; end: number }[]; hasTranscript: boolean; analyzedAt: string;
}

/** Analyze ENTIRE video, persist signals (resumable: skips if analysis file exists), then rank candidates. */
/** Preferred clip length (Ssemble-style buckets). */
export type LengthBucket = 'u30' | '30-60' | '60-90' | '90-180';
export const LENGTHS: Record<LengthBucket, { minSec: number; maxSec: number; targetSec: number }> = { u30: { minSec: 12, maxSec: 30, targetSec: 22 }, '30-60': { minSec: 30, maxSec: 60, targetSec: 45 }, '60-90': { minSec: 60, maxSec: 90, targetSec: 75 }, '90-180': { minSec: 90, maxSec: 180, targetSec: 130 } };
export function isLengthBucket(x: unknown): x is LengthBucket { return typeof x === 'string' && x in LENGTHS; }
export async function analyzeVideo(store: Store, cfg: Config, videoId: number, o: { force?: boolean; override?: { introEnd?: number; outroStart?: number }; length?: LengthBucket; whole?: boolean } = {}): Promise<{ candidates: number; analysisPath: string }> {
  if (o.length) cfg = { ...cfg, clip: { ...cfg.clip, ...LENGTHS[o.length] } };
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
      // Speech-to-text only when no transcript sidecar exists and an engine is available. Failure is non-fatal (clips just lack captions).
      if (cfg.stt.mode === 'auto' && m.hasAudio && loadTranscript(v.path.replace(/\.[^.]+$/, '')).length === 0) {
        const sc = channelOfVideo(store, videoId); const t = await transcribeVideo(cfg, v.path, { language: sc.config.language, prompt: cfg.stt.prompt ?? (sc.profile === 'gaming' ? 'Free Fire gameplay commentary in Hinglish: booyah, headshot, clutch, squad, zone, knocked, rush, 1v4.' : undefined) });
        if (t.status === 'failed') warn('transcription failed; continuing without captions', { videoId, error: t.error });
      }
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
    const chan = channelOfVideo(store, videoId); const external = loadExternalSeries(v.path.replace(/\.[^.]+$/, ''), a.duration);
    if (chan.config.killfeed) { try { const kf = await scanKillfeed(v.path, a.duration, cfg.dirs.tmp, { region: chan.config.killfeed === true ? undefined : chan.config.killfeed }); if (kf) external.push(kf); } catch (e) { warn('killfeed scan failed', { err: (e as Error).message.slice(0, 80) }); } }
    if (external.length) info('external signals used', { videoId, series: external.map((x) => x.name) });
    let cands = selectCandidates({ videoKey: String(videoId), duration: a.duration, introEnd: a.introEnd, outroStart: a.outroStart, energy: a.energy, energyStep: a.energyStep, scenes: a.scenes, silence: a.silence, cues, external, gaming: chan.profile === 'gaming', categoryPrior: learnedCategoryPrior(store, chan.id) },
      { minSec: cfg.clip.minSec, maxSec: cfg.clip.maxSec, targetSec: cfg.clip.targetSec, maxClips: cfg.clip.maxClipsPerVideo, minScore: cfg.clip.minScore, maxOverlap: cfg.clip.maxOverlap });
    if (o.whole) { // "no clipping": the whole chosen range (intro/outro limits) becomes ONE clip
      const t = cands[0]; if (!t) throw new Error('whole-range clip needs at least one scored moment in the range; analyse a longer range');
      const st = a.introEnd, en = a.outroStart; const txt = textInRange(cues, st, en); const fp = shortHash(`${videoId}:whole:${Math.round(st)}:${Math.round(en)}`, 16);
      cands = [{ ...t, start: st, end: en, duration: +(en - st).toFixed(2), transcript: txt, language: guessLanguage(txt), fingerprint: fp, reason: 'whole range as one clip', hook: sentencesFromCues(cues).find((s) => s.start >= st)?.text.slice(0, 140) ?? t.hook }];
    }
    type PartInfo = { no: number; total: number; key: string };
    const partOf = new Map<string, PartInfo>();
    if (cfg.clip.series?.enabled && cues.length && !o.whole) {
      const sents = sentencesFromCues(cues); const occupied: [number, number][] = []; const out: typeof cands = [];
      for (const c of [...cands].sort((x, y) => y.score - x.score)) {
        if (occupied.some((o) => overlapRatio([c.start, c.end], o) > 0.2)) continue;
        const spans = planSeries(c.start, c.end, sents, { minSec: cfg.clip.minSec, maxSec: cfg.clip.maxSec, partSec: cfg.clip.series.partSec, maxParts: cfg.clip.series.maxParts, hi: a.outroStart });
        if (!spans) { out.push(c); occupied.push([c.start, c.end]); continue; }
        const key = `s${videoId}_${Math.round(c.start)}`; occupied.push([spans[0]!.start, spans[spans.length - 1]!.end]);
        spans.forEach((sp, i) => { const txt = textInRange(cues, sp.start, sp.end); const inS = sentencesIn(sents, sp.start, sp.end); const fp = shortHash(`${videoId}:${Math.round(sp.start)}:${Math.round(sp.end)}`, 16);
          out.push({ ...c, start: sp.start, end: sp.end, duration: +(sp.end - sp.start).toFixed(2), score: +(c.score * (i === 0 ? 1 : 0.97)).toFixed(4), transcript: txt, language: guessLanguage(txt), hook: (inS[0]?.text ?? c.hook).slice(0, 140), reason: `${c.reason}; part ${i + 1}/${spans.length} of one story`, fingerprint: fp }); partOf.set(fp, { no: i + 1, total: spans.length, key }); });
      }
      cands = out.sort((x, y) => x.start - y.start);
    }
    { const rr = await rerankCandidates(cands, llmChain(cfg)); cands = rr.cands; if (rr.used) info('llm rerank', { used: rr.used }); else if (rr.note) warn(rr.note); }
    let inserted = 0;
    store.tx(() => {
      // Re-analysis (e.g. new transcript): unrendered candidates are re-ranked; already-rendered clips are never duplicated.
      store.exec(`UPDATE candidates SET status='superseded' WHERE video_id=? AND status='candidate'`, videoId);
      const rendered = store.all<{ start_sec: number; end_sec: number }>(`SELECT start_sec, end_sec FROM candidates WHERE video_id=? AND status='rendered'`, videoId);
      for (const c of cands) {
        if (rendered.some((r) => overlapRatio([c.start, c.end], [r.start_sec, r.end_sec]) > 0.5)) continue;
        const r = store.exec(
          `INSERT INTO candidates(video_id, start_sec, end_sec, score, category, reason, hook, transcript, language, confidence, signals_json, fingerprint, part_no, part_total, series_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(fingerprint) DO UPDATE SET status=CASE WHEN candidates.status='superseded' THEN 'candidate' ELSE candidates.status END, score=excluded.score, reason=excluded.reason, hook=excluded.hook, transcript=excluded.transcript, language=excluded.language, signals_json=excluded.signals_json, part_no=excluded.part_no, part_total=excluded.part_total, series_key=excluded.series_key`,
          videoId, c.start, c.end, c.score, c.category, c.reason, c.hook, c.transcript, c.language, c.confidence, JSON.stringify(c.signals), c.fingerprint!, partOf.get(c.fingerprint!)?.no ?? null, partOf.get(c.fingerprint!)?.total ?? null, partOf.get(c.fingerprint!)?.key ?? null);
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
