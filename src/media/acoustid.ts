import { run } from '../util/proc.ts';

export interface AudioMatch { score: number; title: string | null; artist: string | null; recordingId: string | null }
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Chromaprint fingerprint made by ffmpeg itself (no fpcalc needed). Null if this ffmpeg has no chromaprint muxer or the file has no audio. */
export async function fingerprint(file: string, maxSec = 120): Promise<{ fp: string; duration: number } | null> {
  const r = await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-t', String(maxSec), '-ac', '1', '-f', 'chromaprint', '-fp_format', 'base64', '-'], { timeoutMs: 120_000 }).catch(() => null);
  const fp = r?.code === 0 ? r.stdout.trim() : ''; if (!fp) return null;
  const p = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30_000 }).catch(() => null);
  const d = Math.min(maxSec, Math.round(Number(p?.stdout.trim()) || 0)); return d > 0 ? { fp, duration: d } : null;
}

/** AcoustID lookup (free key from acoustid.org). Best recording match or null. Network errors => null (the check is advisory, never blocks). */
export async function lookup(key: string, f: { fp: string; duration: number }, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<AudioMatch | null> {
  const body = new URLSearchParams({ client: key, duration: String(f.duration), fingerprint: f.fp, meta: 'recordings', format: 'json' }).toString();
  try {
    const r = await fetcher('https://api.acoustid.org/v2/lookup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }); if (!r.ok) return null;
    const j = (await r.json()) as { status?: string; results?: { score?: number; recordings?: { id?: string; title?: string; artists?: { name?: string }[] }[] }[] };
    if (j.status !== 'ok') return null; const top = (j.results ?? []).filter((x) => (x.recordings?.length ?? 0) > 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]; if (!top) return null;
    const rec = top.recordings![0]!; return { score: top.score ?? 0, title: rec.title ?? null, artist: rec.artists?.map((a) => a.name).filter(Boolean).join(', ') || null, recordingId: rec.id ?? null };
  } catch { return null; }
}
export const acoustidKey = (cfg: { copyright?: { acoustidKey?: string } }): string | undefined => cfg.copyright?.acoustidKey || process.env.ACOUSTID_KEY || undefined;

const cache = new Map<string, AudioMatch | null>();
/** Is this library track a known commercial recording? Cached per file+size. Tracks with a licence in library.json are trusted (owner cleared them). */
export async function musicRisk(path: string, key: string, minScore: number, f: Fetcher = fetch as unknown as Fetcher, fp = fingerprint): Promise<AudioMatch | null> {
  if (cache.has(path)) return cache.get(path)!; const p = await fp(path, 60); const m = p ? await lookup(key, p, f) : null; const hit = m && m.score >= minScore ? m : null; cache.set(path, hit); return hit;
}
