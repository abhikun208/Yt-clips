import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/util/proc.ts';
import { loadConfig } from '../src/config.ts';

export function tmpDir(): string { return mkdtempSync(join(tmpdir(), 'ytc-test-')); }
export function testConfig(over: Record<string, unknown> = {}) {
  return loadConfig(process.cwd(), { dataDir: tmpDir(), overrides: over });
}
/** Short synthetic clip: 4s black+silence, 20s tone/pattern, 4s black+silence. No real content. */
export async function makeFixture(out: string, mid = 20): Promise<void> {
  const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15:d=4', '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=15:d=${mid}`, '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15:d=4',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=4', '-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*220*t)*(1+sin(2*PI*3*t))/2:s=44100:d=${mid}`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=4',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(r.stderr);
}
