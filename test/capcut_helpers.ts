import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { blankDraft, addVideo, writeNewDraft } from '../src/capcut/newdraft.ts';
import { addCues } from '../src/capcut/subs.ts';
import { probe } from '../src/capcut/media.ts';
import { run } from '../src/capcut/cli.ts';

export const tmp = (): string => mkdtempSync(join(tmpdir(), 'capcut-test-'));
/** A real 6 s 640x360 clip with a sine tone (0-3 s) then silence (3-4 s) then tone again (4-6 s). */
export function makeVideo(dir: string, name = 'clip.mp4', secs = 6): string {
  const f = join(dir, name);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-af', "volume='if(between(t,3,4),0,1)':eval=frame", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  if (r.status !== 0) throw new Error('ffmpeg fixture failed: ' + r.stderr);
  return f;
}
export function makeDraft(root: string, name = 'proj', opts: { subs?: boolean } = {}): { dir: string; video: string } {
  const video = makeVideo(root); const p = probe(video); const j = blankDraft({ name, width: 1080, height: 1920, fps: 25 });
  addVideo(j, p, { at: 0, fill: true }); if (opts.subs !== false) addCues(j, [{ start: 500_000, end: 2_000_000, text: 'hello world' }, { start: 2_500_000, end: 4_000_000, text: 'second line' }, { start: 4_500_000, end: 5_800_000, text: 'third one' }]);
  const dir = join(root, 'drafts', name); writeNewDraft((mkd(dir), dir), j, [p]); return { dir, video };
}
import { mkdirSync } from 'node:fs';
const mkd = (d: string) => mkdirSync(d, { recursive: true });
export function cli(args: string[]): { code: number; out: string; err: string } {
  let out = '', err = ''; const code = run([...args, '--force'], { out: (s) => { out += s + '\n'; }, err: (s) => { err += s + '\n'; }, color: false }); return { code, out, err };
}
void writeFileSync;
