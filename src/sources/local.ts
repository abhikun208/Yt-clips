import { existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { probe } from '../media/probe.ts';
import { fileFingerprint } from '../util/hash.ts';

const MEDIA_EXT = /\.(mp4|mkv|mov|webm|avi|m4v|mp3|wav|m4a|flv)$/i;

export interface IngestResult { videoId: number; duplicate: boolean; path: string }

/** Add a local media file. Original is COPIED into data/source_videos (never moved/modified). Duplicates detected by fingerprint. */
export async function ingestLocal(store: Store, cfg: Config, file: string, opts: { authorized?: boolean; title?: string } = {}): Promise<IngestResult> {
  const abs = resolve(file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`File not found: ${abs}`);
  if (!MEDIA_EXT.test(abs)) throw new Error(`Unsupported media type: ${basename(abs)}`);
  const fp = fileFingerprint(abs);
  const existing = store.get<{ id: number; path: string }>('SELECT id, path FROM videos WHERE fingerprint=?', fp);
  if (existing) return { videoId: existing.id, duplicate: true, path: existing.path };
  const info = await probe(abs); // throws on corrupt / no video stream
  mkdirSync(cfg.dirs.sources, { recursive: true });
  let dest = join(cfg.dirs.sources, basename(abs));
  if (existsSync(dest)) dest = join(cfg.dirs.sources, `${fp.slice(0, 8)}_${basename(abs)}`);
  copyFileSync(abs, dest);
  const src = store.exec('INSERT INTO sources(kind, uri, title, authorized) VALUES (?,?,?,?) ON CONFLICT(uri) DO UPDATE SET title=excluded.title', 'local', abs, opts.title ?? basename(abs), opts.authorized ? 1 : 0);
  const srcRow = store.get<{ id: number }>('SELECT id FROM sources WHERE uri=?', abs)!;
  void src;
  const v = store.exec(
    `INSERT INTO videos(source_id, path, fingerprint, size, duration, width, height, fps, has_audio, state) VALUES (?,?,?,?,?,?,?,?,?, 'NEW')`,
    srcRow.id, dest, fp, statSync(dest).size, info.duration, info.width, info.height, info.fps, info.hasAudio ? 1 : 0);
  store.logState('video', v.lastId, null, 'NEW', 'ingested local');
  return { videoId: v.lastId, duplicate: false, path: dest };
}
