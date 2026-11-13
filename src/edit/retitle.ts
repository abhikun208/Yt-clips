import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run } from '../util/proc.ts';
import { probe } from '../media/probe.ts';
import { buildStyledAss } from './captions.ts';
import { encodeArgs, withEncoderFallback } from '../media/encoder.ts';
import { qcClip } from './qc.ts';
import { installedFonts } from '../util/fonts.ts';
import { info, warn } from '../util/log.ts';
import { planBroll, fetchBroll, brollKey } from './broll.ts';

/** AI title -> what is printed on the video: no #tags, no emoji, no foreign letters, max ~64 chars cut at a word. null when nothing usable is left. */
export function screenTitle(title: string | null | undefined, max = 44): string | null {
  let t = String(title ?? '').replace(/#\w+/g, ' ').replace(/[\p{Extended_Pictographic}‍️]/gu, ' ').replace(/\s*•\s*\d+\s*$/, '').replace(/[^\u0000-ɏ‐-‧]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) { t = t.slice(0, max + 1); t = t.slice(0, Math.max(t.lastIndexOf(' '), 20)).trim(); }
  return t.length >= 4 ? t : null;
}

/**
 * The clip is rendered WITHOUT its on-screen title (manifest.render.titleDeferred); the metadata step then watches the finished clip
 * (frames + speech), writes the title, and this pass prints it as the top strip (whole clip) in ONE light re-encode (audio copied).
 * Optional B-roll cutaways (Pexels, needs key + edit.broll=true) are laid in the same pass. Any failure keeps the untouched clip.
 */
export async function finishClip(store: Store, cfg: Config, clipId: number, aiTitle: string | null, broll: string[] = [], fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; why?: string; title?: string; broll?: number }> {
  const row = store.get<{ edited_path: string | null; manifest_path: string | null; output_id: string }>('SELECT edited_path, manifest_path, output_id FROM clips WHERE id=?', clipId);
  if (!row?.edited_path || !row.manifest_path || !existsSync(row.edited_path) || !existsSync(row.manifest_path)) return { ok: false, why: 'files missing' };
  const man = JSON.parse(readFileSync(row.manifest_path, 'utf8')) as { render?: Record<string, any> }; const d = man.render?.titleDeferred as { title: string | null; label: string | null } | null | undefined;
  if (!d) return { ok: false, why: 'title not deferred (already on the video)' };
  const title = screenTitle(aiTitle) ?? screenTitle(d.title?.replace(/^PART \d+\/\d+ • /, ''));
  /* <= 44 chars: a long title is shrunk to tiny letters; short = BIG */ const text = [d.label, title].filter(Boolean).join(' • ');
  const tmp = join(cfg.dirs.tmp, `${row.output_id}.finish.mp4`); const assPath = join(cfg.dirs.tmp, `${row.output_id}.finish.ass`);
  try {
    const m = await probe(row.edited_path);
    const bar = (man.render?.titleBar ?? cfg.edit.titleBar ?? 'off') as 'black' | 'white' | 'off';
    if (text) writeFileSync(assPath, buildStyledAss([], 0, m.duration, text, { width: m.width, height: m.height, preset: cfg.edit.captionPreset, titleBar: bar, resolveFont: (c) => { const have = installedFonts(); return c.find((x) => have.has(x.toLowerCase())); } }).ass, 'utf8');
    const slots = planBroll(m.duration).slice(0, broll.length); const esc = (p: string) => p.replace(/\\/g, '/').replace(/[:']/g, '\\$&');
    const inputs = ['-i', row.edited_path]; for (let i = 0; i < slots.length; i++) inputs.push('-ss', '0', '-t', String(slots[i]!.end - slots[i]!.start + 0.2), '-i', broll[i]!);
    const y0 = Math.round(m.height * 0.14), h = Math.round(m.height * 0.44) & ~1, w = m.width & ~1; const f: string[] = []; let last = '0:v';
    slots.forEach((s, i) => { f.push(`[${i + 1}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${Math.round(m.fps) || 30},setpts=PTS-STARTPTS+${s.start}/TB[b${i}]`); f.push(`[${last}][b${i}]overlay=0:${y0}:enable='between(t,${s.start},${s.end})':eof_action=pass[o${i}]`); last = `o${i}`; });
    if (text) f.push(`[${last}]ass='${esc(assPath)}':fontsdir='${esc(join(cfg.dirs.assets, 'fonts'))}'[vout]`); else f.push(`[${last}]null[vout]`);
    const r = await withEncoderFallback(cfg, (enc) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', '0:a?', ...encodeArgs(enc, { crf: cfg.edit.crf, preset: 'veryfast' }), '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', tmp], { timeoutMs: 15 * 60_000 }));
    if (r.code !== 0) throw new Error(`ffmpeg: ${r.stderr.trim().slice(-200)}`);
    const o = await probe(tmp);
    if (Math.abs(o.duration - m.duration) > 0.4 || o.hasAudio !== m.hasAudio || o.width !== m.width || o.height !== m.height) throw new Error(`output check failed (${o.duration.toFixed(2)}s vs ${m.duration.toFixed(2)}s)`);
    const qc = await qcClip(tmp, { width: cfg.edit.width, height: cfg.edit.height, duration: m.duration, targetLufs: cfg.edit.targetLufs, requireAudio: m.hasAudio });
    renameSync(tmp, row.edited_path);
    man.render = { ...man.render, titleDeferred: null, titleBurned: text || null, broll: slots.length }; writeFileSync(row.manifest_path, JSON.stringify(man, null, 2));
    store.exec('UPDATE clips SET qc_json=?, qc_pass=?, state=? WHERE id=?', JSON.stringify(qc), qc.pass ? 1 : 0, qc.pass ? 'QC_PASSED' : 'QC_FAILED', clipId);
    info('title strip added after the AI watched the clip', { clip: clipId, title: text, broll: slots.length });
    return { ok: true, title: text, broll: slots.length };
  } catch (e) {
    warn('title strip pass failed - clip kept without title strip', { clip: clipId, err: String((e as Error).message).slice(0, 200) }); return { ok: false, why: (e as Error).message };
  } finally { rmSync(tmp, { force: true }); rmSync(assPath, { force: true }); }
}

/** B-roll for this clip: only with edit.broll=true AND a Pexels key; search terms are the AI's English stock-footage terms. */
export async function brollFor(cfg: Config, terms: string[], fetchFn: typeof fetch = fetch): Promise<string[]> {
  if (cfg.edit.broll !== true || !brollKey() || !terms.length) return [];
  return fetchBroll(join(cfg.dataDir, 'broll'), terms, 3, fetchFn);
}
