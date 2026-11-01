import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { openDraft, newDraftDir, type J } from './draft.ts';
import { probe, haveFfmpeg } from './media.ts';
import { blankDraft, addVideo, writeNewDraft } from './newdraft.ts';
import { addCues, tidy, type Cue } from './subs.ts';
import { applyTemplate, readStore, type Template } from './styles.ts';
import { diagnose, applyFixes } from './doctor.ts';
import { renderPreview } from './preview.ts';
import { recomputeDuration } from './model.ts';

export interface ClipDraftIn { videoPath: string; name: string; /** seconds on the draft timeline (after cuts) */ cues: { start: number; end: number; text: string }[]; /** jump-cut plan: ranges of the video that are kept, in seconds (dead air is left out, like the final edit) */ keep?: { start: number; end: number }[] }
export interface ClipDraftOut { dir: string; subtitles: number; fixed: string[]; remaining: string[]; preview?: string }

/** Where drafts go: data/capcut-drafts unless capcut.draftsDir is set (e.g. the real CapCut drafts folder). */
const tlEnd = (j: J, fallback: number): number => Math.max(...j.tracks.flatMap((t: J) => t.segments.map((x: J) => x.target_timerange.start + x.target_timerange.duration)), 0) || fallback;
export const draftsRoot = (cfg: Config): string => resolve(cfg.capcut?.draftsDir || join(cfg.dataDir, 'capcut-drafts'));

/**
 * Build an editable CapCut/JianYing draft for one finished clip, entirely offline: 9:16 canvas, the clip filling the frame,
 * subtitles from the transcript, optional saved template, then doctor+fix. The final upload file is still rendered by the Yt-clips
 * ffmpeg pipeline (hook, music, beat effects, LUT, QC); this draft is the "open it in CapCut and polish" copy and the CLI-checked preview.
 */
export function makeClipDraft(cfg: Config, i: ClipDraftIn): ClipDraftOut {
  if (!haveFfmpeg()) throw new Error('ffmpeg/ffprobe missing');
  const p = probe(i.videoPath); if (!p.duration) throw new Error('cannot read clip length');
  const seed = cfg.capcut?.seedDraft ? openDraft(cfg.capcut.seedDraft) : undefined;
  const w = cfg.edit.width, h = cfg.edit.height; const j: J = blankDraft({ name: i.name, width: w, height: h, fps: Math.round(p.fps || cfg.edit.fps), seed: seed?.json });
  const fill = w < h && p.width > p.height; const kept = (i.keep ?? []).map((k) => ({ a: Math.max(0, Math.round(k.start * 1e6)), b: Math.min(p.duration, Math.round(k.end * 1e6)) })).filter((k) => k.b - k.a > 100_000);
  if (kept.length > 1) { let at = 0; for (const k of kept) { addVideo(j, p, { srcStart: k.a, srcDur: k.b - k.a, at, fill }); at += k.b - k.a; } } else addVideo(j, p, { at: 0, fill });
  const cues: Cue[] = i.cues.map((c) => ({ start: Math.max(0, Math.round(c.start * 1e6)), end: Math.min(tlEnd(j, p.duration), Math.round(c.end * 1e6)), text: c.text.trim() })).filter((c) => c.end > c.start && c.text);
  if (cues.length) { addCues(j, cues); tidy(j); }
  if (cfg.capcut?.template) { try { applyTemplate(j, readStore<Template>('templates', cfg.capcut.template), { keepCanvas: true }); } catch { /* template missing: keep default look */ } }
  recomputeDuration(j);
  const fs = diagnose(j, { checkMedia: true }); const fixed = applyFixes(fs); const left = diagnose(j).filter((f) => f.level !== 'info').map((f) => f.message);
  const dir = newDraftDir(draftsRoot(cfg), i.name.replace(/[^\w\-. ]/g, '_').slice(0, 60)); writeNewDraft(dir, j, [p], seed?.dir);
  let preview: string | undefined;
  if (cfg.capcut?.preview) { try { preview = join(dir, 'preview.mp4'); renderPreview(j, { out: preview, height: 540 }); } catch { preview = undefined; } }
  writeFileSync(join(dir, 'README.txt'), `Made by Yt-clips (offline CapCut bridge). Source: ${i.videoPath}\nOpen CapCut, close it before running "capcut ..." edits. Check: node src/cli.ts capcut doctor "${dir}"\n`);
  return { dir, subtitles: cues.length, fixed, remaining: left, preview };
}
void existsSync; void mkdirSync;
