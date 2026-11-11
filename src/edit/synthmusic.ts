import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/proc.ts';

/**
 * Built-in, copyright-free background music: soft pad chords synthesised by ffmpeg (no download, no key, no licence problem).
 * Made once, only when assets/music has no audio file (owner files always win). Quiet by design: the render ducks it under the voice.
 */
const TRACKS: { file: string; mood: string[]; notes: number[]; bpm: number }[] = [
  { file: 'synth-chill.mp3', mood: ['chill', 'story', 'education', 'general'], notes: [220, 277.18, 329.63], bpm: 70 },
  { file: 'synth-energy.mp3', mood: ['energetic', 'gaming', 'sports', 'funny', 'comedy'], notes: [196, 246.94, 293.66], bpm: 120 },
  { file: 'synth-drama.mp3', mood: ['dramatic', 'emotional', 'motivation', 'news'], notes: [174.61, 207.65, 261.63], bpm: 80 },
];
const AUDIO = /\.(mp3|wav|m4a|ogg)$/i;
const done = new Set<string>();
export async function ensureSynthMusic(assetsDir: string): Promise<number> {
  if (done.has(assetsDir)) return 0; done.add(assetsDir);
  const dir = join(assetsDir, 'music'); try { mkdirSync(dir, { recursive: true }); } catch { return 0; }
  if (existsSync(dir) && readdirSync(dir).some((f) => AUDIO.test(f))) return 0;
  const made: { file: string; mood: string[]; license: string; source: string; volume: number }[] = [];
  for (const t of TRACKS) {
    const ins = t.notes.flatMap((n) => ['-f', 'lavfi', '-i', `sine=f=${n}:d=40:r=44100`]);
    const mix = `[0:a][1:a][2:a]amix=inputs=3:normalize=0,volume=0.5,tremolo=f=${(t.bpm / 60 / 2).toFixed(3)}:d=0.35,lowpass=f=1800,aecho=0.7:0.6:380|760:0.35|0.2,afade=t=in:d=2,afade=t=out:st=38:d=2,aformat=channel_layouts=stereo[o]`;
    const r = await run('ffmpeg', ['-y', '-v', 'error', ...ins, '-filter_complex', mix, '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '96k', join(dir, t.file)], { timeoutMs: 60_000 }).catch(() => null);
    if (r && r.code === 0) made.push({ file: t.file, mood: t.mood, license: 'Synthesised by yt-clips - CC0, no copyright', source: 'built-in generator (src/edit/synthmusic.ts)', volume: 0.12 });
  }
  if (made.length) writeFileSync(join(dir, 'library.json'), JSON.stringify(made, null, 1));
  return made.length;
}
