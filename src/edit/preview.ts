import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/proc.ts';
import { getPreset } from './captionPresets.ts';
import { buildStyledAss } from './captions.ts';
import { installedFonts } from '../util/fonts.ts';

const SAMPLE: Record<string, string> = { en: 'Ye secret ka raaz kisi ko nahi pata tha', hi: 'यह एक सच्चा राज़ है दोस्त किसी को नहीं पता' };

/** Render a real preview PNG of a caption preset (burned with the same libass renderer used for exports). Cached on disk. */
export async function presetPreview(dir: string, presetId: string, lang: 'en' | 'hi' = 'en'): Promise<string> {
  const p = getPreset(presetId); if (!p) throw new Error('unknown preset');
  mkdirSync(dir, { recursive: true });
  const png = join(dir, `${presetId}.${lang}.png`); if (existsSync(png)) return png;
  const toks = SAMPLE[lang]!.split(' ');
  const words = toks.map((t, i) => ({ start: 0.2 + i * 0.35, end: 0.5 + i * 0.35, text: t }));
  const cues = [{ start: 0.2, end: 0.5 + toks.length * 0.35, text: toks.join(' '), words }];
  const have = installedFonts();
  const r = buildStyledAss(cues, 0, 5, null, { width: 360, height: 640, preset: presetId, resolveFont: (c) => c.find((x) => have.has(x.toLowerCase())) });
  const ass = png.replace(/\.png$/, '.ass'); writeFileSync(ass, r.ass);
  const t = (0.2 + Math.min(3, toks.length - 1) * 0.35 + 0.1).toFixed(2);
  const esc = ass.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const out = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2B3240:s=360x640:r=10:d=5', '-vf', `vignette=PI/4,subtitles='${esc}'`, '-ss', t, '-frames:v', '1', png], { timeoutMs: 30_000 });
  if (out.code !== 0 || !existsSync(png)) throw new Error(`preview failed: ${out.stderr.slice(0, 200)}`);
  return png;
}
