import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { J } from './draft.ts';
import { materialsOf, getText, subtitles, type Sub } from './model.ts';

/** Reusable looks live in ~/.capcut-cli (override: CAPCUT_HOME). Plain JSON files: easy to share and edit. */
export const homeDir = (env: NodeJS.ProcessEnv = process.env): string => env.CAPCUT_HOME || join(homedir(), '.capcut-cli');
const dirFor = (kind: 'styles' | 'templates', env?: NodeJS.ProcessEnv): string => { const d = join(homeDir(env), kind); mkdirSync(d, { recursive: true }); return d; };
const safe = (n: string): string => { if (!/^[\w\- .]{1,60}$/.test(n)) throw new Error('name: letters, digits, space, - _ . only (max 60)'); return n.trim(); };
export const listStore = (kind: 'styles' | 'templates', env?: NodeJS.ProcessEnv): string[] => readdirSync(dirFor(kind, env)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
export const removeStore = (kind: 'styles' | 'templates', name: string, env?: NodeJS.ProcessEnv): boolean => { const f = join(dirFor(kind, env), safe(name) + '.json'); if (!existsSync(f)) return false; rmSync(f); return true; };
export const readStore = <T>(kind: 'styles' | 'templates', name: string, env?: NodeJS.ProcessEnv): T => { const f = join(dirFor(kind, env), safe(name) + '.json'); if (!existsSync(f)) throw new Error(`${kind.slice(0, -1)} "${name}" not found (capcut ${kind === 'styles' ? 'style' : 'template'} list)`); return JSON.parse(readFileSync(f, 'utf8')) as T; };
const writeStore = (kind: 'styles' | 'templates', name: string, v: unknown, env?: NodeJS.ProcessEnv): string => { const f = join(dirFor(kind, env), safe(name) + '.json'); writeFileSync(f, JSON.stringify(v, null, 2)); return f; };

export interface TextStyle { version: 1; material: J; run: J; clip: J | null; note?: string }
const SKIP = new Set(['id', 'content', 'words', 'base_content', 'name', 'material_name', 'text', 'recognize_text']);
export function extractStyle(j: J, s: Sub): TextStyle {
  const mat = (j.materials.texts as J[]).find((m) => m.id === s.ref.seg.material_id)!; const material: J = {}; for (const [k, v] of Object.entries(mat)) if (!SKIP.has(k)) material[k] = JSON.parse(JSON.stringify(v));
  let run: J = {}; try { const c = JSON.parse(mat.content); run = c.styles?.[0] ? JSON.parse(JSON.stringify(c.styles[0])) : {}; } catch { /* plain content */ } delete run.range;
  return { version: 1, material, run, clip: s.ref.seg.clip ? JSON.parse(JSON.stringify(s.ref.seg.clip)) : null };
}
export function saveStyle(j: J, s: Sub, name: string, env?: NodeJS.ProcessEnv): string { return writeStore('styles', name, extractStyle(j, s), env); }
/** Apply a saved look to the given subtitles: font/colour/size/outline/shadow, plus on-screen position. Wording is never touched. */
export function applyStyle(j: J, st: TextStyle, subs: Sub[], o: { keepPosition?: boolean } = {}): number {
  let n = 0; for (const s of subs) {
    const mat = (j.materials.texts as J[]).find((m) => m.id === s.ref.seg.material_id); if (!mat) continue;
    for (const [k, v] of Object.entries(st.material)) mat[k] = JSON.parse(JSON.stringify(v));
    let c: J; try { c = JSON.parse(mat.content); } catch { c = { text: getText(mat), styles: [] }; }
    const len = [...String(c.text ?? '')].length; c.styles = [{ ...JSON.parse(JSON.stringify(st.run)), range: [0, len] }]; mat.content = JSON.stringify(c);
    if (st.clip && !o.keepPosition) s.ref.seg.clip = JSON.parse(JSON.stringify(st.clip)); n++;
  } return n;
}
export interface Template { version: 1; canvas_config: J | null; fps: number | null; style: TextStyle | null; note?: string }
export function saveTemplate(j: J, name: string, env?: NodeJS.ProcessEnv): string { const s0 = subtitles(j)[0]; return writeStore('templates', name, { version: 1, canvas_config: j.canvas_config ? JSON.parse(JSON.stringify(j.canvas_config)) : null, fps: typeof j.fps === 'number' ? j.fps : null, style: s0 ? extractStyle(j, s0) : null } satisfies Template, env); }
export function applyTemplate(j: J, t: Template, o: { keepCanvas?: boolean } = {}): { canvas: boolean; styled: number } {
  let canvas = false; if (t.canvas_config && !o.keepCanvas) { j.canvas_config = JSON.parse(JSON.stringify(t.canvas_config)); if (t.fps) j.fps = t.fps; canvas = true; }
  return { canvas, styled: t.style ? applyStyle(j, t.style, subtitles(j)) : 0 };
}
void materialsOf;
