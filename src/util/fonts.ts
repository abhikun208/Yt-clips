import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder with the bundled open-source (OFL) fonts. Used as libass `fontsdir`, so captions work on Termux/minimal hosts without system fonts. */
export const BUNDLED_FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const BUNDLED: [RegExp, string][] = [[/^poppins/i, 'poppins'], [/^poppins-black/i, 'poppins black'], [/^poppins-extrabold/i, 'poppins extrabold'], [/^anton/i, 'anton'], [/^bebasneue/i, 'bebas neue'], [/^notosansdevanagari/i, 'noto sans devanagari']];
export function bundledFamilies(dir = BUNDLED_FONTS_DIR): string[] {
  if (!existsSync(dir)) return [];
  const out = new Set<string>();
  for (const f of readdirSync(dir)) if (/\.(ttf|otf)$/i.test(f)) for (const [re, fam] of BUNDLED) if (re.test(f)) out.add(fam);
  return [...out];
}

let cache: Set<string> | null = null;
/** Lower-cased installed font family names (fc-list). Empty set if fontconfig is missing (caller then warns). */
export function installedFonts(): Set<string> {
  if (cache) return cache;
  const set = new Set<string>();
  try {
    const out = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 10_000 });
    for (const line of out.split('\n')) for (const fam of line.split(',')) { const f = fam.trim().toLowerCase(); if (f) set.add(f); }
  } catch { /* no fontconfig */ }
  for (const f of bundledFamilies()) set.add(f);
  return (cache = set);
}
