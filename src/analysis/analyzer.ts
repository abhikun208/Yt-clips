import { sttPrompt } from './stt.ts';
import { channelOfVideo } from '../channels.ts';
import { loadExternalSeries } from './external.ts';
import { learnedCategoryPrior } from '../publish/service.ts';
import { opportunity, rejectLowOpportunity, maxSimilarity } from './opportunity.ts';
import { scanKillfeed } from './killfeed.ts';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { probe } from '../media/probe.ts';
import { detectSilence, detectScenes, audioEnergy, detectBlack, normalizeEnergy, visualActivity } from './signals.ts';
import { detectMoments, type Moment } from './moment-detector.ts';
import { persistMoments } from './moments-store.ts';
import { detectBoundaries, applySkips } from './boundaries.ts';
import { loadTranscript, textInRange, guessLanguage } from './transcript.ts';
import { sentencesFromCues, sentencesIn, hookScore } from './textsignals.ts';
import { hookCandidates } from '../seo/hooks.ts';
import { rightsScreen } from './rights.ts';
import { planSeries } from './series.ts';
import { shortHash } from '../util/hash.ts';
import { selectCandidates, overlapRatio } from './select.ts';
import { info, warn } from '../util/log.ts';
import { transcribeVideo } from './stt.ts';
import { rerankCandidates } from '../ai/rerank.ts';
import { llmChain } from '../ai/settings.ts';
import { resolveContentProfile } from './profiles.ts';

export interface AnalysisFile {
  videoId: number; duration: number; introEnd: number; outroStart: number; boundaryReasons: string[];
  energyStep: number; energy: number[]; scenes: number[]; silence: { start: number; end: number }[]; hasTranscript: boolean; analyzedAt: string; motion?: { step: number; values: number[] };
}

/** Analyze ENTIRE video, persist signals (resumable: skips if analysis file exists), then rank candidates. */
/** Preferred clip length (Ssemble-style buckets). */
export type LengthBucket = 'u30' | '30-60' | '60-90' | '90-180';
export const LENGTHS: Record<LengthBucket, { minSec: number; maxSec: number; targetSec: number }> = { u30: { minSec: 12, maxSec: 30, targetSec: 22 }, '30-60': { minSec: 30, maxSec: 60, targetSec: 45 }, '60-90': { minSec: 60, maxSec: 90, targetSec: 75 }, '90-180': { minSec: 90, maxSec: 180, targetSec: 130 } };
export function isLengthBucket(x: unknown): x is LengthBucket { return typeof x === 'string' && x in LENGTHS; }
export async function analyzeVideo(store: Store, cfg: Config, videoId: number, o: { force?: boolean; override?: { introEnd?: number; outroStart?: number }; length?: LengthBucket; whole?: boolean; maxClips?: number } = {}): Promise<{ candidates: number; analysisPath: string }> {
  { const cc = channelOfVideo(store, videoId).config; o = { ...o, length: o.length ?? cc.clipLength, maxClips: o.maxClips ?? cc.maxClips }; } // channel automation settings are the default; an explicit request wins
  if (o.length) cfg = { ...cfg, clip: { ...cfg.clip, ...LENGTHS[o.length] } };
  if (o.maxClips !== undefined && Number.isInteger(o.maxClips) && o.maxClips >= 0) cfg = { ...cfg, clip: { ...cfg.clip, maxClipsPerVideo: Math.floor(o.maxClips) } };
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
        const sc = channelOfVideo(store, videoId); const isGaming = sc.profile === 'gaming' || sc.config.contentProfile === 'gaming' || sc.config.contentProfile === 'only_gaming'; const t = await transcribeVideo(cfg, v.path, { language: sc.config.language, prompt: sttPrompt(cfg, sc.config.vocabulary) ?? (isGaming ? 'Free Fire gameplay commentary in Hinglish: booyah, headshot, clutch, squad, zone, knocked, rush, 1v4.' : undefined) });
        if (t.status === 'failed') warn('transcription failed; continuing without captions', { videoId, error: t.error });
      }
      const [silence, scenes, black, en] = await Promise.all([
        detectSilence(v.path), detectScenes(v.path), detectBlack(v.path), m.hasAudio ? audioEnergy(v.path, 0.5) : Promise.resolve({ step: 0.5, values: [] }),
      ]);
      let motion: AnalysisFile['motion']; if (cfg.clip.moments?.enabled !== false && m.videoCodec) { try { const vm = await visualActivity(v.path); motion = { step: vm.motion.step, values: vm.motion.values.map((x) => +x.toFixed(2)) }; } catch (e) { warn('visual motion scan failed; moments use the other signals', { err: (e as Error).message.slice(0, 80) }); } }
      const b = detectBoundaries(m.duration, { silence, black, scenes, introMaxSec: cfg.clip.introMaxSec, outroMaxSec: cfg.clip.outroMaxSec, override: o.override });
      const norm = normalizeEnergy(en);
      const cues = loadTranscript(v.path.replace(/\.[^.]+$/, ''));
      a = { videoId, duration: m.duration, introEnd: b.introEnd, outroStart: b.outroStart, boundaryReasons: b.reasons, energyStep: en.step, energy: norm, scenes, silence, hasTranscript: cues.length > 0, analyzedAt: new Date().toISOString(), ...(motion ? { motion } : {}) };
      writeFileSync(analysisPath, JSON.stringify(a));
    }
    { const k = applySkips(a.duration, a.introEnd, a.outroStart, { skipHeadSec: cfg.clip.skipHeadSec, skipTailSec: cfg.clip.skipTailSec, override: o.override }); if (k.reasons.length) { a = { ...a, introEnd: k.introEnd, outroStart: k.outroStart, boundaryReasons: [...(a.boundaryReasons ?? []), ...k.reasons] }; } }
    const cues = loadTranscript(v.path.replace(/\.[^.]+$/, ''));
    const chan = channelOfVideo(store, videoId); const external = loadExternalSeries(v.path.replace(/\.[^.]+$/, ''), a.duration);
    if (chan.config.killfeed) { try { const kf = await scanKillfeed(v.path, a.duration, cfg.dirs.tmp, { region: chan.config.killfeed === true ? undefined : chan.config.killfeed }); if (kf) external.push(kf); } catch (e) { warn('killfeed scan failed', { err: (e as Error).message.slice(0, 80) }); } }
    if (external.length) info('external signals used', { videoId, series: external.map((x) => x.name) });
    const contentProfile = resolveContentProfile(chan.config.contentProfile, cues.map((c) => c.text).join(' '));
    if (chan.config.contentProfile === 'auto') info('content profile inferred from transcript', { videoId, profile: contentProfile });
    let cands = selectCandidates({ videoKey: String(videoId), duration: a.duration, introEnd: a.introEnd, outroStart: a.outroStart, energy: a.energy, energyStep: a.energyStep, scenes: a.scenes, silence: a.silence, cues, external, gaming: chan.profile === 'gaming' || contentProfile === 'gaming' || contentProfile === 'only_gaming', profile: contentProfile, vocabulary: chan.config.vocabulary, categoryPrior: learnedCategoryPrior(store, chan.id) },
      { minSec: cfg.clip.minSec, maxSec: cfg.clip.maxSec, targetSec: cfg.clip.targetSec, maxClips: cfg.clip.maxClipsPerVideo, minScore: cfg.clip.minScore, maxOverlap: cfg.clip.maxOverlap });
    // A SHORT source (<= clip.shortSourceSec, default 75 s) is already a Short: it becomes exactly ONE final clip (captions, effects, metadata added), never cut into several. An explicit length bucket / whole:false still wins.
    const bridge = (() => { try { const r = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `live:bridge:${videoId}`); return r ? (JSON.parse(r.v) as { seam: number }) : null; } catch { return null; } })(); // live chunk-seam video: only moments that cross the seam matter
    const whole = !bridge && (o.whole === true || (o.whole !== false && !o.length && a.duration > 0 && a.duration <= (cfg.clip.shortSourceSec ?? 75)));
    if (whole && !cands[0] && o.whole) throw new Error('whole-range clip needs at least one scored moment in the range; analyse a longer range');
    if (whole && (cands[0] || (!o.whole && contentProfile !== 'only_gaming'))) { // "no clipping": the whole chosen range (intro/outro limits) becomes ONE clip. Strict gaming profiles never bypass their content gate.
      const t = cands[0] ?? { start: 0, end: a.duration, duration: a.duration, score: 0.5, category: 'general', reason: 'whole range as one clip', hook: '', transcript: '', language: 'hi', confidence: 0.5, signals: {} };
      const st = o.whole ? a.introEnd : 0, en = o.whole ? a.outroStart : a.duration; const txt = textInRange(cues, st, en); const fp = shortHash(`${videoId}:whole:${Math.round(st)}:${Math.round(en)}`, 16);
      cands = [{ ...t, start: st, end: en, duration: +(en - st).toFixed(2), transcript: txt, language: guessLanguage(txt), fingerprint: fp, reason: 'whole range as one clip', hook: sentencesFromCues(cues).find((s) => s.start >= st)?.text.slice(0, 140) ?? t.hook }];
    }
    // multi-signal moments: stored for every tier; EXCEPTIONAL/STRONG moments the classic selector missed are added as candidates (conservative: never over an existing candidate)
    const momentLink = new Map<Moment, { candidateFp: string; origin: 'moment' | 'legacy' }>(); let moments: Moment[] = [];
    if (cfg.clip.moments?.enabled !== false && a.duration > 0) {
      try {
        const md = detectMoments({ duration: a.duration, lo: a.introEnd, hi: a.outroStart, energy: a.energy, energyStep: a.energyStep, silence: a.silence, scenes: a.scenes, ...(a.motion ? { motion: a.motion } : {}), cues, external, gaming: chan.profile === 'gaming' || contentProfile === 'gaming' || contentProfile === 'only_gaming' }, { minSec: cfg.clip.minSec, maxSec: cfg.clip.maxSec, targetSec: cfg.clip.targetSec });
        moments = md.moments; info('moments discovered', { videoId, ...md.stats });
        for (const mo of moments) {
          if (whole) continue; const ov = cands.find((c) => overlapRatio([mo.start, mo.end], [c.start, c.end]) > 0.5);
          if (ov) { momentLink.set(mo, { candidateFp: ov.fingerprint!, origin: 'legacy' }); continue; }
          if (cfg.clip.moments?.addCandidates === false || (mo.tier !== 'EXCEPTIONAL' && mo.tier !== 'STRONG') || mo.score < cfg.clip.minScore || cands.some((c) => overlapRatio([mo.start, mo.end], [c.start, c.end]) > 0.2)) continue;
          const fp = shortHash(`${videoId}:m:${Math.round(mo.start)}:${Math.round(mo.end)}`, 16);
          cands.push({ start: mo.start, end: mo.end, duration: mo.duration, score: mo.score, category: mo.category, reason: mo.explanation, hook: mo.hook, transcript: mo.transcript, language: guessLanguage(mo.transcript), confidence: mo.confidence, signals: { moment: mo.score }, fingerprint: fp }); momentLink.set(mo, { candidateFp: fp, origin: 'moment' });
        }
        cands.sort((x, y) => x.start - y.start);
      } catch (e) { warn('moment engine failed; classic selection is used', { err: (e as Error).message.slice(0, 100) }); moments = []; }
    }
    if (bridge) { cands = cands.filter((c) => c.start < bridge.seam - 1.5 && c.end > bridge.seam + 1.5); for (const mo of [...momentLink.keys()]) if (!(mo.start < bridge.seam - 1.5 && mo.end > bridge.seam + 1.5)) momentLink.delete(mo); moments = moments.filter((mo) => mo.start < bridge.seam - 1.5 && mo.end > bridge.seam + 1.5); }
    type PartInfo = { no: number; total: number; key: string };
    const partOf = new Map<string, PartInfo>();
    if (cfg.clip.series?.enabled && cues.length && !whole) {
      const sents = sentencesFromCues(cues); const occupied: [number, number][] = []; const out: typeof cands = [];
      for (const c of [...cands].sort((x, y) => y.score - x.score)) {
        if (occupied.some((o) => overlapRatio([c.start, c.end], o) > 0.2)) continue;
        const spans = planSeries(c.start, c.end, sents, { minSec: cfg.clip.minSec, maxSec: cfg.clip.maxSec, partSec: cfg.clip.series.partSec, maxParts: cfg.clip.series.maxParts, hi: a.outroStart, scenes: a.scenes, capSec: 60 });
        if (!spans || occupied.some((o) => overlapRatio([spans[0]!.start, spans[spans.length - 1]!.end], o) > 0.2)) { out.push(c); occupied.push([c.start, c.end]); continue; } // a multi-part series must not swallow a clip already taken (or it would repeat that moment)
        const key = `s${videoId}_${Math.round(c.start)}`; occupied.push([spans[0]!.start, spans[spans.length - 1]!.end]);
        spans.forEach((sp, i) => { const txt = textInRange(cues, sp.start, sp.end); const inS = sentencesIn(sents, sp.start, sp.end); const fp = shortHash(`${videoId}:${Math.round(sp.start)}:${Math.round(sp.end)}`, 16);
          out.push({ ...c, start: sp.start, end: sp.end, duration: +(sp.end - sp.start).toFixed(2), score: +(c.score * (i === 0 ? 1 : 0.97)).toFixed(4), transcript: txt, language: guessLanguage(txt), hook: (inS[0]?.text ?? c.hook).slice(0, 140), reason: `${c.reason}; part ${i + 1}/${spans.length} of one story`, fingerprint: fp }); partOf.set(fp, { no: i + 1, total: spans.length, key }); });
      }
      cands = out.sort((x, y) => x.start - y.start);
    }
    if (cfg.clip.faceMood !== false && !whole && cands.length) { try { const { applyFaceMood, pythonFaceRunner } = await import('./facemood.ts'); const fm = await applyFaceMood(cands, v.path, pythonFaceRunner(cfg)); cands = fm.cands; if (fm.used) info('face mood used', { videoId, clips: fm.used }); } catch (e) { warn('face mood failed', { err: (e as Error).message.slice(0, 100) }); } }
    { const rr = await rerankCandidates(cands, llmChain(cfg)); cands = rr.cands; if (rr.used) info('llm rerank', { used: rr.used }); else if (rr.note) warn(rr.note); }
    if (cfg.clip.qualityGate !== false && !whole && cands.length) { // modular quality gate: duplicates, repeated hooks, missing context, bad boundaries, borderline no-payoff; 0 clips stays valid
      const { gateCandidates } = await import('./qualitygate.ts'); const g = gateCandidates(cands, { minScore: cfg.clip.minScore, skip: (c) => partOf.has(c.fingerprint!) });
      if (g.dropped.length) { info('quality gate dropped clips', { videoId, dropped: g.dropped.map((d) => ({ at: Math.round(d.c.start), why: d.reason })) }); cands = g.keep; }
    }
    if (chan.config.contentProfile === 'auto' && cues.length) { const { detectContent } = await import('./contentdetect.ts'); const dc = detectContent(cues.map((c) => c.text).join(' ')); if (dc.profile !== 'general') store.exec('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', `video:content:${videoId}`, JSON.stringify(dc)); }
    // opportunity score (0-100, 13 sub-scores): stored for every candidate; an extra rejection only when the owner sets clip.opportunityMin (default off)
    const oppPrior = learnedCategoryPrior(store, chan.id) as Record<string, number> | undefined; const oppPast = store.all<{ transcript: string | null }>(`SELECT transcript FROM candidates WHERE status='rendered' AND transcript IS NOT NULL ORDER BY id DESC LIMIT 200`).map((r) => r.transcript ?? '').filter(Boolean);
    const oppCtx = (c: (typeof cands)[number]) => ({ ...(oppPast.length && c.transcript ? { similarityToPast: maxSimilarity(c.transcript, oppPast) } : {}), ...(oppPrior?.[c.category] ? { categoryPrior: oppPrior[c.category]! } : {}) });
    if ((cfg.clip.opportunityMin ?? 0) > 0 && !whole && cands.length) { const g = rejectLowOpportunity(cands, cfg.clip.opportunityMin!, oppCtx); if (g.dropped.length) { info('opportunity gate dropped clips', { videoId, dropped: g.dropped.map((d) => ({ at: Math.round(d.c.start), score: d.score })) }); cands = g.keep; } }
    // truthful hook candidates (verbatim lines of the clip); the best one replaces the stored hook only when it is clearly stronger
    const hooksByFp = new Map<string, ReturnType<typeof hookCandidates>>();
    if (cfg.clip.smartHooks !== false && cues.length && !whole) { const allS = sentencesFromCues(cues); for (const c of cands) { const h = hookCandidates(sentencesIn(allS, c.start, c.end)); hooksByFp.set(c.fingerprint!, h); if (h.best && hookScore(h.best.text) >= hookScore(c.hook) + 0.1) c.hook = h.best.text.slice(0, 140); } }
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
    for (const c of cands) { const row = store.get<{ id: number }>('SELECT id FROM candidates WHERE fingerprint=?', c.fingerprint!); if (!row) continue; const o = opportunity(c, oppCtx(c)); store.exec(`INSERT INTO candidate_opportunity(candidate_id, score, parts_json) VALUES (?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET score=excluded.score, parts_json=excluded.parts_json, computed_at=datetime('now')`, row.id, o.score, JSON.stringify({ parts: o.parts, unavailable: o.unavailable, reasons: o.reasons })); }
    if (moments.length) { try { persistMoments(store, videoId, moments, momentLink); } catch (e) { warn('moments not stored', { err: (e as Error).message.slice(0, 100) }); } }
    for (const [fp, h] of hooksByFp) { const row = store.get<{ id: number }>('SELECT id FROM candidates WHERE fingerprint=?', fp); if (row) store.exec(`INSERT INTO candidate_hooks(candidate_id, best, candidates_json) VALUES (?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET best=excluded.best, candidates_json=excluded.candidates_json, computed_at=datetime('now')`, row.id, h.best?.text ?? null, JSON.stringify({ candidates: h.candidates, slowIntro: h.slowIntro, note: h.note })); }
    { const own = [chan.name, chan.slug, ...(((chan.config as { handles?: string[] }).handles) ?? [])]; for (const c of cands) { const row = store.get<{ id: number }>('SELECT id FROM candidates WHERE fingerprint=?', c.fingerprint!); if (!row) continue; const r = rightsScreen({ transcript: c.transcript ?? '', duration: c.duration, ownNames: own }); store.exec(`INSERT INTO candidate_rights(candidate_id, decision, flags_json, detail_json) VALUES (?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET decision=excluded.decision, flags_json=excluded.flags_json, detail_json=excluded.detail_json, computed_at=datetime('now')`, row.id, r.decision, JSON.stringify(r.flags), JSON.stringify(r)); if (r.decision !== 'ok') info('rights screen', { videoId, at: Math.round(c.start), decision: r.decision, reasons: r.reasons }); } }
    store.logState('video', videoId, prev, 'ANALYZED', `${cands.length} candidates, ${inserted} new (${basename(v.path)})`);
    if (cands.length) info('analysis result', { videoId, clips: cands.length, scores: cands.slice(0, 4).map((x) => +x.score.toFixed(2)) });
    else warn('analysis found NO clip', { videoId, duration: Math.round(a.duration), minSec: cfg.clip.minSec, why: a.duration < cfg.clip.minSec ? 'video clip-minimum se chhoti hai: Re-analyze > Original mode (whole) use karo' : 'koi hissa minScore paar nahi kar paya ya bolne wala hissa nahi mila: Re-analyze karo ya minScore kam karo' });
    return { candidates: cands.length, analysisPath };
  } catch (e) {
    store.exec(`UPDATE videos SET state='FAILED', error=?, updated_at=datetime('now') WHERE id=?`, (e as Error).message.slice(0, 500), videoId);
    throw e;
  }
}
