import { run } from '../util/proc.ts';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Perceptual fingerprint of a clip: 3 keyframes (25/50/75 %) → 9x8 grayscale → 64-bit difference hash each. Robust to re-encoding,
 * small colour grades and scaling; not to heavy reframing. Pure ffmpeg, no extra dependency.
 */
export async function clipHash(path: string, duration: number): Promise<string | null> {
  const parts: string[] = [];
  for (const f of [0.25, 0.5, 0.75]) {
    const tmp = join(tmpdir(), `ytc-ph-${process.pid}-${Math.round(f * 100)}-${Date.now()}.pgm`);
    const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, duration * f).toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'scale=9:8:flags=area,format=gray', tmp], { timeoutMs: 30_000 }).catch(() => null);
    let buf: Buffer | null = null; try { if (r && r.code === 0) { const raw = readFileSync(tmp); buf = raw.subarray(raw.length - 72); } } catch { buf = null; } finally { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } }
    if (!buf || buf.length < 72) return null;
    let bits = 0n; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (buf[y * 9 + x]! > buf[y * 9 + x + 1]! ? 1n : 0n);
    parts.push(bits.toString(16).padStart(16, '0'));
  }
  return parts.join('');
}
/** 0..1 similarity of two clipHash strings (1 = identical frames). */
export function hashSimilarity(a: string, b: string): number {
  if (a.length !== b.length || !a.length) return 0; let diff = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16); while (x) { diff += x & 1; x >>= 1; } }
  return 1 - diff / (a.length * 4);
}
