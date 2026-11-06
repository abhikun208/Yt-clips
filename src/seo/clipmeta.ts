import { titleIssues } from './titlegate.ts';
import { clipFrames, describeFrames, isVisionModel, isLocalEndpoint } from './vision.ts';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { loadTranscript, guessLanguage, type Cue } from '../analysis/transcript.ts';
import { transcribeVideo } from '../analysis/stt.ts';
import { buildMetadata, validateMetadata, lintPackage, withPart, type Metadata } from './metadata.ts';
import { llmMetadata } from './llm.ts';
import { llmChain } from '../ai/settings.ts';
import { makeThumbnail } from './thumbnail.ts';
import { suggestKeywords } from './suggest.ts';
import { channelOfClip } from '../channels.ts';
import { notify } from '../notify.ts';
import { info, warn } from '../util/log.ts';

const chMeta = (ch: ReturnType<typeof channelOfClip>) => ({ channelName: ch.name, ownerLinks: ch.config.links, hashtagsExtra: ch.config.hashtags });
const stripTitle = (t: string) => t.replace(/#shorts/i, '').replace(/\(Part \d+\/\d+\)/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Analysis-first metadata for ONE rendered clip (used by the meta job, "remeta", and the pre-publish safety net):
 * 1) make sure the clip's real speech is known (transcribe the rendered clip if the candidate has no transcript),
 * 2) brief → title/description/tags/thumbnail text (+ YouTube search suggestions, + LLM polish when configured),
 * 3) never reuse another clip's title of the same channel, 4) mark `generic` when there was no speech to work from.
 */
export async function metaForClip(store: Store, cfg: Config, clipId: number, o: { notifyOwner?: boolean } = {}): Promise<Metadata & { thumbnailOk: boolean }> {
  const row = store.get<{ id: number; candidate_id: number; edited_path: string; output_id: string }>('SELECT id, candidate_id, edited_path, output_id FROM clips WHERE id=?', clipId); if (!row) throw new Error(`unknown clip ${clipId}`);
  const ch = channelOfClip(store, clipId);
  const cand = store.get<{ category: string; transcript: string | null; language: string | null; start_sec: number; end_sec: number; hook: string | null; part_no: number | null; part_total: number | null; video_id: number }>('SELECT category, transcript, language, start_sec, end_sec, hook, part_no, part_total, video_id FROM candidates WHERE id=?', row.candidate_id)!;
  let transcript = (cand.transcript ?? '').trim(); let language = cand.language ?? 'unknown';
  if (transcript.split(/\s+/).length < 8 && row.edited_path) { // no usable speech stored → listen to the finished clip itself
    try { const tr = await transcribeVideo(cfg, row.edited_path, { language: ch.config.language }); if (tr.status !== 'ok') warn('speech-to-text did not return text', { clip: clipId, status: tr.status, error: (tr as { error?: string }).error }); const txt = tr.cues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim(); if (txt.split(/\s+/).length >= 4) { transcript = txt; language = guessLanguage(txt); store.exec(`UPDATE candidates SET transcript=?, language=? WHERE id=?`, txt, language, row.candidate_id); info('clip transcribed for metadata', { clip: clipId, engine: tr.engine }); } else warn('no speech found for metadata', { clip: clipId, status: tr.status }); } catch (e) { warn('metadata transcription failed', { clip: clipId, err: (e as Error).message.slice(0, 100) }); }
  }
  const part = cand.part_no && cand.part_total ? { no: cand.part_no, total: cand.part_total } : null;
  let cues: Cue[] = []; try { const vp = store.get<{ path: string }>('SELECT path FROM videos WHERE id=?', cand.video_id)?.path; if (vp) cues = loadTranscript(vp.replace(/\.[^.]+$/, '')); } catch { /* chapters omitted */ }
  const srcRow = store.get<{ title: string | null; path: string }>('SELECT s.title, v.path FROM videos v LEFT JOIN sources s ON s.id=v.source_id WHERE v.id=?', cand.video_id); const sourceTitle = (srcRow?.title ?? srcRow?.path.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/[-_]?[A-Za-z0-9_-]{11}$/, '').replace(/[_]+/g, ' ').trim() ?? '') || undefined;
  let hookTxt = cand.hook ?? undefined; // same script as the burned-in captions: with captionLanguage auto/hinglish a Hindi clip is written in Roman Hinglish everywhere (title, description, tags), never Devanagari mixed with Roman
  { const to = ch.config.translateTo ?? cfg.edit.captionLanguage ?? 'auto'; const { toHinglish, hasDevanagari } = await import('../ai/hinglish.ts');
    if ((to === 'auto' || to === 'hinglish') && (hasDevanagari(transcript) || (hookTxt && hasDevanagari(hookTxt)))) { transcript = toHinglish(transcript); if (hookTxt) hookTxt = toHinglish(hookTxt); cues = cues.map((c) => ({ ...c, text: toHinglish(c.text) })); if (language === 'hi') language = 'hinglish'; } }
  const base = { sourceTitle, transcript, category: cand.category, language: language ?? 'unknown', hook: hookTxt, cues, clipStart: cand.start_sec, duration: cand.end_sec - cand.start_sec, part, ...chMeta(ch) };
  const first = buildMetadata(base);
  const related = transcript ? await suggestKeywords(store, first.keywords[0] ?? '', { hl: language === 'en' ? 'en' : 'hi' }) : [];
  let md = related.length ? buildMetadata({ ...base, relatedExtra: related }) : first;
  if (related.length) md = { ...md, warnings: [...md.warnings, `search suggestions used: ${related.slice(0, 3).join(' | ')}`] };
  let trends: string[] = []; if (transcript && llmChain(cfg).length) { try { const { fetchTrends, relevantTrends } = await import('./trends.ts'); trends = relevantTrends(transcript, await fetchTrends(store)); } catch { trends = []; } }
  let examples: string[] = []; let insight: string | null = null; try { const { topTitleExamples } = await import('./learning.ts'); const { mainChannel } = await import('../channels.ts'); examples = topTitleExamples(store, ch.id, mainChannel(store)?.id ?? ch.id); if (examples.length >= 2) { const { hookInsight } = await import('./learning.ts'); insight = await hookInsight(store, ch.id, examples, llmChain(cfg)); } } catch { examples = []; }
  let visual: string | null = null; const vKey = `vision:${new Date().toISOString().slice(0, 10)}`; const vUsed = Number(store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', vKey)?.v ?? 0); // cloud image quotas: at most 10 clips (30 images) a day; an own local vision model (Ollama...) has no quota and is the unlimited fallback
  const vChain = (await import('../ai/health.ts')).orderChain(llmChain(cfg).filter((c) => isVisionModel(c.model))).filter((c) => isLocalEndpoint(c.baseUrl) || vUsed < 10).sort((a, b) => Number(isLocalEndpoint(a.baseUrl)) - Number(isLocalEndpoint(b.baseUrl)));
  if (vChain.length && cfg.vision?.enabled !== false && process.env.YT_CLIPS_VISION !== '0') { try { const frames = await clipFrames(row.edited_path, cand.end_sec - cand.start_sec); for (const v of vChain) { visual = await describeFrames({ baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model }, frames); if (visual) { if (!isLocalEndpoint(v.baseUrl)) store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, vKey, String(vUsed + 1)); break; } } } catch { visual = null; } }
  let bestLlm: { md: Metadata; bad: number } | null = null;
  if (transcript) for (const llm of (await import('../ai/health.ts')).orderChain(llmChain(cfg))) { const r = await llmMetadata(md, transcript, { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model }, fetch, trends, examples, insight, visual); if (r.source === 'llm') { const cand2 = { ...r, generatedBy: `${new URL(llm.baseUrl).hostname.replace(/^(api|www)\./, '')} · ${llm.model}` }; const bad = titleIssues(r.title, sourceTitle).length; if (!bestLlm || bad < bestLlm.bad) bestLlm = { md: cand2, bad }; if (!bad) break; } else md = r; }
  if (bestLlm) md = bestLlm.md; // the provider with the fewest objective title problems (first clean one wins immediately)
  md = { ...md, generatedBy: md.generatedBy ?? 'rules (no AI answered)' }; md = withPart(md, part);
  { const dis = (ch.config as { disclaimer?: string }).disclaimer?.trim(); if (dis && !md.description.includes(dis)) md = { ...md, description: `${md.description}\n\n${dis}`.slice(0, 4900) }; } // owner-written, per channel
  // never the same title twice on one channel
  const used = new Set(store.all<{ metadata_json: string | null }>(`SELECT c.metadata_json FROM clips c JOIN candidates cd ON cd.id=c.candidate_id WHERE c.id<>? AND c.metadata_json IS NOT NULL ORDER BY c.id DESC LIMIT 300`, clipId).map((r) => { try { return stripTitle((JSON.parse(r.metadata_json!) as { title?: string }).title ?? ''); } catch { return ''; } }).filter(Boolean));
  if (used.has(stripTitle(md.title))) {
    const alt = md.titles.find((t) => !used.has(stripTitle(t)));
    if (alt) md = { ...md, title: withPart({ ...md, title: `${alt.slice(0, 90)} #Shorts` }, part).title, warnings: [...md.warnings, 'title was already used on another clip: alternative picked'] };
    else md = { ...md, title: `${md.title.replace(/ #Shorts$/i, '').slice(0, 80)} • ${clipId} #Shorts`.slice(0, 100), warnings: [...md.warnings, 'duplicate title: clip number added'] };
  }
  const generic = md.generic === true || transcript.split(/\s+/).length < 8; md = { ...md, generic };
  const errs = validateMetadata(md); if (errs.length) throw new Error(`metadata invalid: ${errs.join('; ')}`);
  { const lw = lintPackage(md); if (lw.length) warn('metadata advice', { lw }); }
  const thumb = await makeThumbnail(row.edited_path, join(cfg.dirs.thumbnails, `${row.output_id}.jpg`), md.thumbnailText).catch((e: Error) => { warn('thumbnail failed', { clip: clipId, err: e.message.slice(0, 80) }); return null; });
  store.exec('UPDATE clips SET metadata_json=?, thumbnail_path=? WHERE id=?', JSON.stringify({ ...md, thumbnailOk: !!thumb }), thumb?.path ?? null, clipId);
  if (o.notifyOwner !== false) void notify(store, cfg, `clip:${clipId}`, `Clip ready for review: ${md.titles[0] ?? row.output_id} (${ch.name}). Dashboard → Clips.`);
  return { ...md, thumbnailOk: !!thumb };
}
