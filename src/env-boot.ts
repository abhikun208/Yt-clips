import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Load `.env` from the project root (zero-dependency). Real environment variables always win over the file. Imported first by server/main.ts and cli.ts. */
export function loadDotEnv(dir = resolve(process.cwd())): { file: string | null; names: string[] } {
  const file = join(dir, '.env'); if (!existsSync(file)) return { file: null, names: [] };
  let parsed: Record<string, string> = {}; try { parsed = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>; } catch { return { file, names: [] }; }
  const names: string[] = [];
  for (const [k, v] of Object.entries(parsed)) { const val = String(v ?? '').trim(); if (!val) continue; names.push(k); if (process.env[k] === undefined || process.env[k] === '') process.env[k] = val; }
  return { file, names };
}
export const dotEnvInfo = loadDotEnv();
