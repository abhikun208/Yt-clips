import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { validateMetadata, type Metadata } from '../seo/metadata.ts';
import { makeThumbnail } from '../seo/thumbnail.ts';
import { renderCandidate, type RenderOptions } from '../edit/render.ts';
import { getPreset } from '../edit/captionPresets.ts';
import { writeZip } from './zip.ts';

interface ClipRow { id: number; candidate_id: number; output_id: string; edited_path: string | null; thumbnail_path: string | null; metadata_json: string | null; review: string; variant: number }
const clipOf = (store: Store, id: number): ClipRow => { const c = store.get<ClipRow>('SELECT id, candidate_id, output_id, edited_path, thumbnail_path, metadata_json, review, variant FROM clips WHERE id=?', id); if (!c) throw new Error(`Unknown clip ${id}`); return c; };

/** Owner decision on a rendered clip. `requireReview` (config) makes the automation loop wait for 'approved'; 'rejected' is never auto-queued. */
export function reviewClip(store: Store, id: number, action: 'approve' | 'reject' | 'reset', note?: string): string {
  const c = clipOf(store, id); const to = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending';
  if (!['approve', 'reject', 'reset'].includes(action)) throw new Error('invalid: action');
  store.exec('UPDATE clips SET review=?, review_note=? WHERE id=?', to, note ? note.slice(0, 300) : null, id);
  store.logState('clip-review', id, c.review, to, note?.slice(0, 120));
  return to;
}

/** Owner edits to title/description/tags (validated like generated metadata). Marks the metadata as edited so the pipeline never overwrites it. */
export function editClipMeta(store: Store, id: number, e: { title?: string; description?: string; tags?: string[]; thumbnailText?: string }): Metadata {
  const c = clipOf(store, id); if (!c.metadata_json) throw new Error('invalid: clip has no metadata yet');
  const md = JSON.parse(c.metadata_json) as Metadata & { edited?: boolean };
  if (e.title !== undefined) md.title = String(e.title).replace(/\s+/g, ' ').trim().slice(0, 100);
  if (e.description !== undefined) md.description = String(e.description).slice(0, 4900);
  if (e.tags !== undefined) { if (!Array.isArray(e.tags)) throw new Error('invalid: tags must be an array'); md.tags = e.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 15); }
  if (e.thumbnailText !== undefined) md.thumbnailText = String(e.thumbnailText).trim().slice(0, 24);
  const errs = validateMetadata(md); if (errs.length) throw new Error(`invalid: ${errs.join('; ')}`);
  md.edited = true; store.exec('UPDATE clips SET metadata_json=? WHERE id=?', JSON.stringify(md), id); return md;
}

/** New thumbnail from the chosen frame (seconds into the edited clip), with the clip's thumbnail text. Returns null if the frame is rejected (flat/blank). */
export async function setThumbnailFrame(store: Store, cfg: Config, id: number, atSec: number): Promise<string | null> {
  const c = clipOf(store, id); if (!c.edited_path || !existsSync(c.edited_path)) throw new Error('invalid: clip file missing');
  if (!(atSec >= 0 && atSec < 600)) throw new Error('invalid: at');
  const md = c.metadata_json ? (JSON.parse(c.metadata_json) as Metadata) : null;
  const t = await makeThumbnail(c.edited_path, join(cfg.dirs.thumbnails, `${c.output_id}.jpg`), md?.thumbnailText ?? '', atSec);
  if (!t) return null; store.exec('UPDATE clips SET thumbnail_path=? WHERE id=?', t.path, id); return t.path;
}

/** Re-render the same moment with other options into a NEW output (v2, v3...). The previous output is never overwritten; metadata is copied; thumbnail regenerated. */
export async function rerenderClip(store: Store, cfg: Config, id: number, opts: Pick<RenderOptions, 'captionPreset' | 'zoom' | 'glow' | 'fade' | 'vfx' | 'jumpCuts' | 'speedRamp' | 'beats'>): Promise<{ clipId: number; outputId: string; qcPass: boolean }> {
  const c = clipOf(store, id);
  if (opts.captionPreset && opts.captionPreset !== 'none' && !getPreset(opts.captionPreset)) throw new Error('invalid: unknown caption preset');
  const next = (store.get<{ v: number }>('SELECT COALESCE(MAX(variant),0)+1 v FROM clips WHERE candidate_id=?', c.candidate_id)?.v) ?? 1;
  const md = c.metadata_json ? (JSON.parse(c.metadata_json) as Metadata) : null;
  const r = await renderCandidate(store, cfg, c.candidate_id, { ...opts, variant: next, title: md ? md.title.replace(/ ?#\w+/g, '') : null });
  if (c.metadata_json) {
    const th = await makeThumbnail(r.editedPath, join(cfg.dirs.thumbnails, `${r.outputId}.jpg`), md?.thumbnailText ?? '').catch(() => null);
    store.exec('UPDATE clips SET metadata_json=?, thumbnail_path=? WHERE id=?', c.metadata_json, th?.path ?? null, r.clipId);
  }
  return { clipId: r.clipId, outputId: r.outputId, qcPass: r.qcPass };
}

/** Manual-posting bundle (for Instagram/TikTok/Facebook or anywhere the owner posts by hand): mp4, thumbnail, srt, title/description/tags and a post.md — one ZIP in data/exports. */
export function exportPackage(store: Store, cfg: Config, id: number): { path: string; name: string; files: string[] } {
  const c = clipOf(store, id); if (!c.edited_path || !existsSync(c.edited_path)) throw new Error('invalid: clip file missing');
  const md = c.metadata_json ? (JSON.parse(c.metadata_json) as Metadata) : null; const dir = join(cfg.dataDir, 'exports'); mkdirSync(dir, { recursive: true });
  const files: { name: string; data: Buffer }[] = [{ name: `${c.output_id}.mp4`, data: readFileSync(c.edited_path) }];
  if (c.thumbnail_path && existsSync(c.thumbnail_path)) files.push({ name: `${c.output_id}_thumbnail.jpg`, data: readFileSync(c.thumbnail_path) });
  const srt = join(cfg.dataDir, 'captions', `${c.output_id}.srt`); if (existsSync(srt)) files.push({ name: `${c.output_id}.srt`, data: readFileSync(srt) });
  if (md) {
    const hash = md.hashtags?.join(' ') ?? '';
    files.push({ name: 'title.txt', data: Buffer.from(md.title) }, { name: 'description.txt', data: Buffer.from(md.description) }, { name: 'tags.txt', data: Buffer.from(md.tags.join(', ')) });
    files.push({ name: 'post.md', data: Buffer.from(`# ${md.title}\n\n${md.description}\n\nTags: ${md.tags.join(', ')}\n${hash ? `Hashtags: ${hash}\n` : ''}\nUpload manually: Instagram Reels / TikTok / Facebook Reels / YouTube Shorts. Check each platform's rules; no view guarantees.\n`) });
  }
  const name = `${c.output_id}_${Date.now().toString(36)}.zip`; const out = join(dir, name); writeZip(out, files);
  return { path: out, name, files: files.map((f) => f.name) };
}
