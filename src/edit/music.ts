import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Owner-supplied, pre-cleared background music (YouTube Audio Library, Pixabay Music, Free Music Archive, own tracks, ...). Nothing is bundled or downloaded.
 * assets/music/*.mp3|wav|m4a|ogg  +  optional assets/music/library.json:
 *   [{ "file": "calm.mp3", "mood": ["comedy","funny"], "license": "YouTube Audio Library – no attribution", "source": "https://…", "volume": 0.15 }]
 * With a library.json only the listed files are used; without it every file in the folder is (the owner put it there). The pick is deterministic per clip
 * (mood match first, then rotation by clip id so one track is not on every video) and the licence/source go into the clip manifest.
 */
export interface MusicEntry { file: string; mood?: string[]; license?: string; source?: string; volume?: number }
export interface MusicPick { path: string; license?: string; source?: string; volume?: number; matchedMood: boolean }

const AUDIO = /\.(mp3|wav|m4a|ogg)$/i;
export function loadLibrary(assetsDir: string): { dir: string; tracks: MusicEntry[]; curated: boolean } {
  const dir = join(assetsDir, 'music'); if (!existsSync(dir)) return { dir, tracks: [], curated: false };
  const files = readdirSync(dir).filter((f) => AUDIO.test(f)).sort();
  const lib = join(dir, 'library.json');
  if (existsSync(lib)) { try { const j = JSON.parse(readFileSync(lib, 'utf8')) as MusicEntry[]; if (Array.isArray(j)) return { dir, curated: true, tracks: j.filter((e) => e && typeof e.file === 'string' && files.includes(e.file)).map((e) => ({ ...e, volume: typeof e.volume === 'number' ? Math.min(1, Math.max(0.02, e.volume)) : undefined })) }; } catch { /* broken JSON: fall back to the plain folder */ } }
  return { dir, tracks: files.map((file) => ({ file })), curated: false };
}

export function pickMusicTrack(assetsDir: string, o: { mood?: string; seed?: number } = {}): MusicPick | undefined {
  const { dir, tracks } = loadLibrary(assetsDir); if (!tracks.length) return undefined;
  const mood = (o.mood ?? '').toLowerCase(); const hit = mood ? tracks.filter((t) => (t.mood ?? []).some((m) => m.toLowerCase() === mood || mood.includes(m.toLowerCase()))) : [];
  const pool = hit.length ? hit : tracks; const t = pool[Math.abs(o.seed ?? 0) % pool.length]!;
  return { path: join(dir, t.file), license: t.license, source: t.source, volume: t.volume, matchedMood: hit.length > 0 };
}
