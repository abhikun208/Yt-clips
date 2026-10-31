import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tolerant `.env` parser (zero-dependency). Handles what real users actually type/paste: UTF-8 BOM, CRLF (Windows/Notepad), `export KEY=…`,
 * spaces around `=`, "double"/'single' quotes, trailing `# comments` on unquoted values, keys with `.`/`-`, blank/commented lines. Never throws.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n|\r/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s*(.*)$/.exec(line); if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === '`') && v.length > 1) { const end = v.indexOf(q, 1); v = end > 0 ? v.slice(1, end) : v.slice(1); if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = v;
  }
  return out;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Load `.env`: from the current directory first, else the project folder (so `node /path/Yt-clips/src/...` from anywhere still works). Real environment variables win over the file. */
export function loadDotEnv(dir = resolve(process.cwd()), alt: string | null = REPO_ROOT): { file: string | null; names: string[] } {
  const file = [join(dir, '.env'), alt ? join(alt, '.env') : ''].find((f) => f && existsSync(f)); if (!file) return { file: null, names: [] };
  let parsed: Record<string, string> = {}; try { parsed = parseDotEnv(readFileSync(file, 'utf8')); } catch { return { file, names: [] }; }
  const names: string[] = [];
  for (const [k, v] of Object.entries(parsed)) { const val = v.trim(); if (!val) continue; names.push(k); if (process.env[k] === undefined || process.env[k] === '') process.env[k] = val; }
  return { file, names };
}
export const dotEnvInfo = loadDotEnv();
