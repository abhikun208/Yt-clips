import { existsSync, renameSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import type { Cue } from '../analysis/transcript.ts';
import { guessLanguage } from '../analysis/transcript.ts';
import { transcribeVideo } from '../analysis/stt.ts';
import { translateCues } from '../ai/translate.ts';
import { llmChain } from '../ai/settings.ts';
import { synthesize, DEFAULT_VOICE } from '../tts/engine.ts';
import { channelOfClip } from '../channels.ts';
import { qcClip } from './qc.ts';
import { probe } from '../media/probe.ts';
import { run } from '../util/proc.ts';
import { info, warn } from '../util/log.ts';

/**
 * Voice-over dubbing of the FINISHED clip (post-render step; the locked render engine is not touched).
 * English speech -> Hindi (the owner's LLM chain translates, sentence by sentence) -> neural TTS per sentence (edge-tts: the most natural free Indian voices;
 * VoiceStudio/piper also work) -> every sentence is placed at the time the English sentence started, sped up (max 1.30x) only when it would run into the next one ->
 * the original audio is ducked (not removed: room/game sound stays, so it feels real) -> loudness normalised -> re-checked by the media QC.
 * Honest limits: this is a neural TTS voice, not a clone of the speaker; without internet/TTS/LLM the clip is left in its original language and the reason is stored.
 */
export interface DubDeps {
  transcribe: (path: string) => Promise<{ cues: Cue[]; ok: boolean }>;
  translate: (cues: Cue[]) => Promise<{ cues: Cue[]; used: string | null; note?: string }>;
  synth: (text: string, voice: string) => Promise<{ path: string; provider: string } | null>;
}
export interface DubPlanItem { start: number; end: number; text: string; file: string; dur: number; rate: number }
export const MAX_RATE = 1.3;

/** merge cues that are very close (a sentence split across subtitle lines must be spoken as one phrase) */
export function groupCues(cues: Cue[], gap = 0.35, maxSec = 9): Cue[] {
  const out: Cue[] = [];
  for (const c of [...cues].sort((a, b) => a.start - b.start)) { const l = out[out.length - 1]; if (l && c.start - l.end <= gap && c.end - l.start <= maxSec && !/[.!?।]\s*$/.test(l.text)) { l.end = Math.max(l.end, c.end); l.text = `${l.text} ${c.text}`.trim(); } else out.push({ start: c.start, end: c.end, text: c.text.trim() }); }
  return out.filter((c) => c.text);
}
export const isEnglish = (cues: Cue[]): boolean => { const t = cues.map((c) => c.text).join(' '); return t.trim().split(/\s+/).length >= 8 && guessLanguage(t) === 'en'; };

/** ffmpeg graph: original ducked while someone speaks, each dub sentence delayed to its slot (tempo-adjusted), mixed + loudness-normalised */
export function dubGraph(items: DubPlanItem[], duck = 0.12, lufs = -14): string {
  const parts: string[] = []; const duckExpr = items.map((i) => `between(t,${Math.max(0, i.start - 0.05).toFixed(2)},${(i.start + Math.max(i.dur / i.rate, i.end - i.start) + 0.15).toFixed(2)})`).join('+');
  parts.push(`[0:a]volume='if(gt(${duckExpr || '0'},0),${duck},1)':eval=frame[o]`);
  items.forEach((it, k) => { const ms = Math.round(it.start * 1000); parts.push(`[${k + 1}:a]${it.rate > 1.005 ? `atempo=${it.rate.toFixed(3)},` : ''}adelay=${ms}|${ms},volume=1.25[d${k}]`); });
  parts.push(`[o]${items.map((_, k) => `[d${k}]`).join('')}amix=inputs=${items.length + 1}:duration=first:normalize=0,loudnorm=I=${lufs}:TP=-1.5:LRA=11,alimiter=limit=0.95[a]`);
  return parts.join(';');
}

async function durOf(f: string): Promise<number> { const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { timeoutMs: 20_000 }); return Number(r.stdout.trim()); }

export async function planDub(cues: Cue[], voice: string, deps: DubDeps, clipDur: number): Promise<{ items: DubPlanItem[]; provider: string } | null> {
  const g = groupCues(cues); const items: DubPlanItem[] = []; let provider = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!; const t = await deps.synth(c.text, voice); if (!t) return null; provider = t.provider;
    const dur = await durOf(t.path); if (!Number.isFinite(dur) || dur <= 0.2) return null;
    const room = Math.max(0.6, (g[i + 1]?.start ?? clipDur) - c.start - 0.08); const rate = Math.min(MAX_RATE, Math.max(1, dur / room));
    items.push({ start: c.start, end: c.end, text: c.text, file: t.path, dur, rate });
  }
  return items.length ? { items, provider } : null;
}

export interface DubResult { status: 'dubbed' | 'skipped' | 'failed'; reason?: string; sentences?: number; maxRate?: number; provider?: string }
const note = (store: Store, clipId: number, r: DubResult): DubResult => { store.exec('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', `dub:${clipId}`, JSON.stringify({ ...r, at: new Date().toISOString() })); return r; };

export function realDubDeps(cfg: Config, voiceCfg?: string): DubDeps {
  return {
    transcribe: async (p) => { const r = await transcribeVideo(cfg, p, { language: 'en' }); return { cues: r.cues, ok: r.status === 'ok' }; },
    translate: (cues) => translateCues(cues, 'hi', llmChain(cfg)),
    synth: (text, voice) => synthesize(text, join(cfg.dirs.tmp, 'dub'), { voice: voiceCfg ?? voice, lang: 'hi', speed: 1 }),
  };
}

export async function dubClip(store: Store, cfg: Config, clipId: number, deps?: DubDeps, o: { force?: boolean } = {}): Promise<DubResult> {
  const row = store.get<{ edited_path: string | null; qc_pass: number | null }>('SELECT edited_path, qc_pass FROM clips WHERE id=?', clipId);
  if (!row?.edited_path || !existsSync(row.edited_path)) return { status: 'skipped', reason: 'clip file nahi mili' };
  const ch = channelOfClip(store, clipId); const mode = ch.config.dubTo ?? 'auto';
  if (mode === 'off') return { status: 'skipped', reason: 'dubbing off for this channel' };
  const done = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', `dub:${clipId}`); if (done && !o.force && JSON.parse(done.v).status === 'dubbed') return { status: 'skipped', reason: 'already dubbed' };
  const d = deps ?? realDubDeps(cfg, ch.config.dubVoice); const file = row.edited_path;
  try {
    const m = await probe(file); if (!m.hasAudio) return note(store, clipId, { status: 'skipped', reason: 'clip me audio nahi' });
    const tr = await d.transcribe(file); if (!tr.ok || !tr.cues.length) return note(store, clipId, { status: 'skipped', reason: 'speech nahi mili / STT available nahi' });
    if (!isEnglish(tr.cues)) return note(store, clipId, { status: 'skipped', reason: 'speech English nahi hai (dub ki zarurat nahi)' });
    if (ch.config.language === 'en' && mode !== 'hi') return note(store, clipId, { status: 'skipped', reason: 'English channel: original English rakhi' });
    const tl = await d.translate(tr.cues); if (!tl.used) return note(store, clipId, { status: 'skipped', reason: tl.note ?? 'translation (LLM) available nahi' });
    const voice = ch.config.dubVoice ?? DEFAULT_VOICE.hi!; const plan = await planDub(tl.cues, voice, d, m.duration);
    if (!plan) return note(store, clipId, { status: 'skipped', reason: 'TTS voice available nahi (edge-tts / piper install karo)' });
    mkdirSync(dirname(file), { recursive: true }); const out = file.replace(/\.mp4$/, '') + '.dub.mp4'; const backup = file.replace(/\.mp4$/, '') + '.pre_dub.mp4';
    const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, ...plan.items.flatMap((i) => ['-i', i.file]), '-filter_complex', dubGraph(plan.items, 0.12, cfg.edit.targetLufs ?? -14), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-t', m.duration.toFixed(3), out], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0 || !existsSync(out)) { rmSync(out, { force: true }); return note(store, clipId, { status: 'failed', reason: `ffmpeg: ${r.stderr.slice(0, 160)}` }); }
    const qc = await qcClip(out, { width: m.width, height: m.height, duration: m.duration, targetLufs: cfg.edit.targetLufs, requireAudio: true });
    if (!qc.pass) { rmSync(out, { force: true }); return note(store, clipId, { status: 'failed', reason: `dub QC failed (${qc.failures.join(', ').slice(0, 120)}); original audio kept` }); }
    copyFileSync(file, backup); renameSync(out, file); store.exec('UPDATE clips SET qc_json=?, qc_pass=1 WHERE id=?', JSON.stringify(qc), clipId);
    const res: DubResult = { status: 'dubbed', sentences: plan.items.length, maxRate: +Math.max(...plan.items.map((i) => i.rate)).toFixed(2), provider: plan.provider }; info('clip dubbed', { clipId, ...res }); return note(store, clipId, res);
  } catch (e) { warn('dubbing failed; original audio kept', { clipId, err: (e as Error).message.slice(0, 120) }); return note(store, clipId, { status: 'failed', reason: (e as Error).message.slice(0, 160) }); }
}
