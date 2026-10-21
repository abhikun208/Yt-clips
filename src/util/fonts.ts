import { execFileSync } from 'node:child_process';

let cache: Set<string> | null = null;
/** Lower-cased installed font family names (fc-list). Empty set if fontconfig is missing (caller then warns). */
export function installedFonts(): Set<string> {
  if (cache) return cache;
  const set = new Set<string>();
  try {
    const out = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 10_000 });
    for (const line of out.split('\n')) for (const fam of line.split(',')) { const f = fam.trim().toLowerCase(); if (f) set.add(f); }
  } catch { /* no fontconfig */ }
  return (cache = set);
}
