import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

/** Loose JSON types: unknown fields are ALWAYS preserved (CapCut misbehaves when they vanish). */
// deno-lint-ignore no-explicit-any
export type J = any;
export interface Draft { dir: string; file: string; fileName: string; json: J; indent: number | string | undefined; raw: string; sidecars: string[]; mirrorFile?: string }

export class DraftError extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } }
const CONTENT_FILES = ['draft_content.json', 'draft_info.json'];

/** Default places where CapCut / JianYing keep drafts (first existing wins; override with CAPCUT_DRAFTS). */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.CAPCUT_DRAFTS) return env.CAPCUT_DRAFTS.split(platform() === 'win32' ? ';' : ':').filter(Boolean);
  const h = homedir(); const out: string[] = [];
  if (platform() === 'win32') { const la = env.LOCALAPPDATA ?? join(h, 'AppData', 'Local'); out.push(join(la, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'), join(la, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')); }
  else if (platform() === 'darwin') out.push(join(h, 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'), join(h, 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
  out.push(join(h, 'capcut-drafts')); return out;
}
export const contentFileOf = (dir: string): string | null => CONTENT_FILES.map((f) => join(dir, f)).find((f) => existsSync(f)) ?? null;
export const looksLikeDraft = (dir: string): boolean => { try { return statSync(dir).isDirectory() && !!contentFileOf(dir); } catch { return false; } };

export interface DraftInfo { dir: string; name: string; modified: Date; file: string }
export function listDrafts(roots = defaultRoots()): DraftInfo[] {
  const out: DraftInfo[] = [];
  for (const r of roots) { let ents: string[] = []; try { ents = readdirSync(r); } catch { continue; } for (const e of ents) { const d = join(r, e); if (looksLikeDraft(d)) { const f = contentFileOf(d)!; out.push({ dir: d, name: e, modified: statSync(f).mtime, file: basename(f) }); } } }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** A draft can be given as a folder, a draft_content.json path, or a folder name / project name found in the default roots. */
export function resolveDraftDir(arg: string, roots = defaultRoots()): string {
  const p = resolve(arg);
  if (existsSync(p)) { if (statSync(p).isFile() && CONTENT_FILES.includes(basename(p))) return dirname(p); if (looksLikeDraft(p)) return p; throw new DraftError('NOT_A_DRAFT', `${p} is not a draft folder (no draft_content.json / draft_info.json inside)`); }
  const all = listDrafts(roots); const hit = all.find((d) => d.name === arg) ?? all.find((d) => d.name.toLowerCase() === arg.toLowerCase()) ?? all.filter((d) => d.name.toLowerCase().includes(arg.toLowerCase()))[0];
  if (hit) return hit.dir;
  throw new DraftError('NOT_FOUND', `draft "${arg}" not found. Looked in: ${roots.join(', ')} (set CAPCUT_DRAFTS, or pass the folder path)`);
}

/** Plain JSON starts with "{" (after an optional BOM). Anything else is treated as an encrypted draft (JianYing 6+), which this tool refuses to touch. */
export function isEncrypted(buf: Buffer): boolean { let i = 0; if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3; while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++; return buf.length > 0 && buf[i] !== 0x7b; }

function detectIndent(raw: string): number | string | undefined { const m = /^\{\r?\n([ \t]+)"/.exec(raw); if (!m) return undefined; return m[1]!.includes('\t') ? '\t' : m[1]!.length; }

export function openDraft(arg: string, roots = defaultRoots()): Draft {
  const dir = resolveDraftDir(arg, roots); const file = contentFileOf(dir)!; const buf = readFileSync(file);
  if (isEncrypted(buf)) throw new DraftError('ENCRYPTED', `${basename(file)} is encrypted (JianYing 6.0+ stores drafts as an encrypted blob). This tool only edits plaintext drafts: CapCut International, or JianYing 5.9 and older. Nothing was changed.`);
  const raw = buf.toString('utf8').replace(/^﻿/, ''); let json: J;
  try { json = JSON.parse(raw); } catch (e) { throw new DraftError('CORRUPT', `${basename(file)} starts like JSON but does not parse (${(e as Error).message.slice(0, 80)}). Restore a backup: capcut restore <draft>`); }
  if (!json || typeof json !== 'object' || !Array.isArray(json.tracks) || typeof json.materials !== 'object') throw new DraftError('NOT_A_DRAFT', `${basename(file)} parsed but has no tracks/materials: not a CapCut draft`);
  const other = CONTENT_FILES.map((f) => join(dir, f)).find((f) => f !== file && existsSync(f));
  return { dir, file, fileName: basename(file), json, indent: detectIndent(raw), raw, sidecars: readdirSync(dir).filter((f) => /^draft_.*\.json$/.test(f) && f !== basename(file)), mirrorFile: other };
}

/** Is CapCut / JianYing running? (Its own save would overwrite our edit.) Best effort, never throws. */
export function appRunning(): string | null {
  try {
    const r = platform() === 'win32' ? spawnSync('tasklist', [], { encoding: 'utf8', timeout: 5000 }) : spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
    const hit = /(capcut|jianying|jianyingpro|剪映)/i.exec(r.stdout ?? ''); return hit ? hit[1]! : null;
  } catch { return null; }
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
export const backupsOf = (d: { dir: string; file: string }): string[] => readdirSync(d.dir).filter((f) => f.startsWith(basename(d.file) + '.bak-')).sort();

/** Atomic, backed-up write: backup copy -> temp file (fsynced) -> rename. Keeps the original indentation and the 5 newest backups. */
export function saveDraft(d: Draft, o: { force?: boolean; skipRunningCheck?: boolean } = {}): { backup: string } {
  if (!o.skipRunningCheck && !o.force) { const app = appRunning(); if (app) throw new DraftError('APP_RUNNING', `${app} is running. Close it first (it would overwrite our edit when it saves), or use --force.`); }
  validateBeforeWrite(d.json);
  const backup = join(d.dir, `${basename(d.file)}.bak-${stamp()}`); copyFileSync(d.file, backup);
  const tmp = d.file + '.tmp-' + process.pid; const text = JSON.stringify(d.json, null, d.indent);
  const fd = openSync(tmp, 'w'); try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  JSON.parse(text); renameSync(tmp, d.file); d.raw = text;
  for (const old of backupsOf(d).slice(0, -5)) rmSync(join(d.dir, old), { force: true });
  return { backup };
}
function validateBeforeWrite(j: J): void { if (!Array.isArray(j.tracks) || typeof j.materials !== 'object') throw new DraftError('INVALID', 'refusing to write: tracks/materials missing'); for (const t of j.tracks) if (!Array.isArray(t.segments)) throw new DraftError('INVALID', 'refusing to write: a track has no segments array'); }

/** Put a backup back (the current file is kept as *.pre-restore-<time>). `which` = part of the backup name; default newest. */
export function restoreBackup(d: { dir: string; file: string }, which?: string): string {
  const b = backupsOf(d); const pick = which ? b.find((x) => x.includes(which)) : b[b.length - 1]; if (!pick) throw new DraftError('NO_BACKUP', 'no backup found (backups are created on every write: draft_content.json.bak-<time>)');
  copyFileSync(d.file, d.file + '.pre-restore-' + stamp()); const tmp = d.file + '.tmp-' + process.pid; copyFileSync(join(d.dir, pick), tmp); renameSync(tmp, d.file); return pick;
}
export function newDraftDir(root: string, name: string): string { mkdirSync(root, { recursive: true }); let dir = join(root, name), n = 2; while (existsSync(dir)) dir = join(root, `${name}_${n++}`); mkdirSync(dir, { recursive: true }); return dir; }
