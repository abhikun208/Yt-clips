import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Candidate } from './select.ts';
import { run, which } from '../util/proc.ts';
import { info } from '../util/log.ts';

export interface FaceMood { faces: number; samples: number; smile: number; surprise: number; sad: number; anger: number; error?: string }
export type FaceRunner = (video: string, start: number, end: number) => Promise<FaceMood | { error: string }>;

/** Default runner: tools/face_mood.py (MediaPipe blendshapes). The model (~3.7 MB) is downloaded once to data/models. */
export const pythonFaceRunner = (cfg: Config): FaceRunner => async (video, a, b) => {
  if (!(await which('python3'))) return { error: 'python3_missing' };
  try { const r = await run('python3', ['-I', join(cfg.rootDir, 'tools', 'face_mood.py'), video, String(a), String(b), '6', join(cfg.dataDir, 'models', 'face_landmarker.task')], { timeoutMs: 120_000 }); return JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as FaceMood; } catch { return { error: 'run_failed' }; }
};

/** Pure: turn the face numbers into a score multiplier + (maybe) a better category. Needs the face visible in >= 2 sampled frames. */
export function moodFromFace(f: FaceMood, c: { category: string; score: number }): { score: number; category: string; label: string | null } {
  if (f.error || f.faces < 2) return { score: c.score, category: c.category, label: null };
  const generic = ['general', 'dialogue', 'dynamic_visuals', 'high_energy'].includes(c.category);
  if (f.smile >= 0.35) return { score: c.score * (1 + Math.min(0.1, f.smile * 0.15)), category: generic ? 'happy' : c.category, label: `smiling (${f.smile})` };
  if (f.surprise >= 0.45) return { score: c.score * 1.06, category: generic ? 'shock' : c.category, label: `surprised face (${f.surprise})` };
  if (f.anger >= 0.4) return { score: c.score * 1.04, category: generic ? 'aggressive' : c.category, label: `angry face (${f.anger})` };
  if (f.sad >= 0.35) return { score: c.score * 1.03, category: generic ? 'sad' : c.category, label: `sad face (${f.sad})` };
  return { score: c.score, category: c.category, label: null };
}

/** Adds the visual-mood signal to each candidate (best ones only). Stops after the first environment error (no mediapipe/model) so it costs nothing there. */
export async function applyFaceMood(cands: Candidate[], video: string, runner: FaceRunner, o: { max?: number } = {}): Promise<{ cands: Candidate[]; used: number; note?: string }> {
  let used = 0; let note: string | undefined; const order = [...cands].sort((a, b) => b.score - a.score).slice(0, o.max ?? 12); const keep = new Set(order);
  for (const c of order) {
    const f = await runner(video, c.start, c.end); if ('error' in f && f.error) { note = `face mood skipped: ${f.error}`; break; }
    const r = moodFromFace(f as FaceMood, c); if (!r.label) continue; used++;
    c.score = +Math.min(1, r.score).toFixed(4); c.category = r.category; c.reason = `${c.reason}; ${r.label}`; c.signals = { ...c.signals, face_smile: (f as FaceMood).smile, face_surprise: (f as FaceMood).surprise };
  }
  void keep; if (note) info(note); return { cands, used, note };
}
