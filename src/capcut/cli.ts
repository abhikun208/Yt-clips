import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { openDraft, saveDraft, listDrafts, defaultRoots, backupsOf, restoreBackup, newDraftDir, DraftError, appRunning, type Draft, type J } from './draft.ts';
import { summarize, allSegments, findSegment, subtitles, mediaList, segLabel, rangeStr, recomputeDuration } from './model.ts';
import { setSpeed, setVolume, trim, moveTo, shift, split, remove, closeGaps } from './edit.ts';
import { parseCues, toSrt, toVtt, addCues, exportCues, editText, replaceText, retime, removeSub, tidy, pick } from './subs.ts';
import { listStore, removeStore, readStore, saveStyle, applyStyle, saveTemplate, applyTemplate, type TextStyle, type Template } from './styles.ts';
import { makeShorts } from './shorts.ts';
import { renderPreview } from './preview.ts';
import { diagnose, applyFixes, summaryLine } from './doctor.ts';
import { blankDraft, addVideo, addAudio, writeNewDraft } from './newdraft.ts';
import { probe, haveFfmpeg } from './media.ts';
import { parseTime, fmt, fmtShort } from './time.ts';

const BOOL = new Set(['json', 'dry-run', 'force', 'ripple', 'regex', 'i', 'no-subs', 'keep-position', 'keep-canvas', 'horizontal', 'help', 'h', 'no-color', 'all']);
export interface Args { cmd: string[]; flags: Record<string, string | true> }
export function parseArgs(argv: string[]): Args {
  const cmd: string[] = []; const flags: Args['flags'] = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!;
    if (a === '--') { cmd.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) { const eq = a.indexOf('='); const k = eq > 0 ? a.slice(2, eq) : a.slice(2); if (eq > 0) flags[k] = a.slice(eq + 1); else if (BOOL.has(k) || i + 1 >= argv.length || (argv[i + 1]!.startsWith('--'))) flags[k] = true; else flags[k] = argv[++i]!; }
    else if (a === '-i') flags.i = true; else if (a === '-h') flags.help = true; else cmd.push(a); }
  return { cmd, flags };
}

export interface Io { out: (s: string) => void; err: (s: string) => void; color: boolean }
const C = (on: boolean) => ({ b: (s: string) => (on ? `\x1b[1m${s}\x1b[22m` : s), dim: (s: string) => (on ? `\x1b[2m${s}\x1b[22m` : s), red: (s: string) => (on ? `\x1b[31m${s}\x1b[39m` : s), grn: (s: string) => (on ? `\x1b[32m${s}\x1b[39m` : s), yel: (s: string) => (on ? `\x1b[33m${s}\x1b[39m` : s) });
function table(rows: string[][], head: string[]): string { const all = [head, ...rows]; const w = head.map((_, i) => Math.max(...all.map((r) => [...(r[i] ?? '')].length))); return all.map((r, k) => r.map((c, i) => (c ?? '') + ' '.repeat(w[i]! - [...(c ?? '')].length)).join('  ').trimEnd() + (k === 0 ? '' : '')).join('\n'); }

export const HELP = `capcut - offline CLI for CapCut / JianYing drafts (plaintext drafts only)

START
  capcut quickstart                      guided tour + checks your setup
  capcut list                            find drafts on this computer
  capcut info <draft>                    summary (tracks, media, subtitles)

INSPECT                 <draft> = folder path, draft_content.json, or a name from "capcut list"
  tracks <draft>        segments <draft> [--track N]        media <draft>

EDIT (close CapCut first; every save makes a backup)
  trim <draft> <seg> [--head 1s] [--tail 2s] [--start t] [--end t] [--ripple]
  move <draft> <seg> <time>              shift <draft> <by> [--seg ref | --track N | --from t]
  speed <draft> <seg> <x>                volume <draft> <seg> <0..10 | 50%>
  split <draft> <seg> <time>             delete <draft> <seg> [--ripple]       gaps <draft> --track N
  <seg> = track:index like 1:3 (see "capcut segments") or an id prefix.  Times: 1.5s 1500ms 1:30 00:01:30.250

SUBTITLES
  subs <draft>                           list      subs set <draft> N "text"     subs delete <draft> N
  subs replace <draft> FIND REPL [--regex] [-i]   subs shift <draft> <by> [--from t]   subs stretch <draft> <factor>
  subs import <draft> file.srt|vtt [--offset t] [--replace]     subs export <draft> [file] [--format srt|vtt]
  subs tidy <draft>                      fix overlaps / too-short cues

STYLES & TEMPLATES (saved in ~/.capcut-cli, override CAPCUT_HOME)
  style save <draft> NAME [--sub N]      style apply <draft> NAME [--sub N] [--keep-position]    style list|remove
  template save <draft> NAME             template apply <draft> NAME [--keep-canvas]             template list|remove

SHORTS & PREVIEW
  shorts <video> [--count 3] [--min 20s] [--max 55s] [--mode silence|subs|even] [--subs file.srt]
         [--out dir] [--seed draft] [--horizontal]       one new 9:16 draft per clip
  new <name> --video f [--audio f] [--size 1080x1920] [--seed draft] [--out dir]
  preview <draft> [--out file.mp4] [--height 540] [--from t] [--to t] [--no-subs]

CHECK & FIX
  doctor <draft>                         find problems      fix <draft>   apply the safe fixes (with backup)
  backup <draft>                         list backups       restore <draft> [name]

GLOBAL  --json  --dry-run (show, don't write)  --force (skip "app is running" check)  CAPCUT_DRAFTS=dir[:dir]
`;

export function run(argv: string[], io: Io): number {
  const { cmd, flags } = parseArgs(argv); const c = C(io.color && !flags['no-color']); const json = !!flags.json; const out = io.out;
  const str = (k: string): string | undefined => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  const tm = (k: string): number | undefined => { const v = str(k); return v === undefined ? undefined : parseTime(v); };
  const need = (i: number, what: string): string => { const v = cmd[i]; if (v === undefined) throw new Error(`missing ${what}. Try: capcut --help`); return v; };
  const emit = (data: unknown, text: () => string) => out(json ? JSON.stringify(data, null, 2) : text());
  const dry = !!flags['dry-run'];
  const save = (d: Draft, what: string) => { recomputeDuration(d.json); if (dry) { out(c.yel(`dry run: nothing written (${what})`)); return; } const r = saveDraft(d, { force: !!flags.force }); out(c.grn('saved') + ` ${what}  ${c.dim('(backup ' + basename(r.backup) + ')')}`); };
  try {
    if (flags.help || cmd.length === 0 || cmd[0] === 'help') { out(HELP); return 0; }
    const [verb] = cmd;
    switch (verb) {
      case 'quickstart': return quickstart(io, c);
      case 'list': { const ds = listDrafts(); emit(ds, () => ds.length ? table(ds.map((d) => [d.name, d.modified.toISOString().slice(0, 16).replace('T', ' '), d.dir]), ['NAME', 'MODIFIED', 'PATH']) : `no drafts found in: ${defaultRoots().join(', ')}\nSet CAPCUT_DRAFTS=/path/to/drafts or pass a folder path.`); return 0; }
      case 'info': case 'open': { const d = openDraft(need(1, 'draft')); const s = summarize(d); emit(s, () => [c.b(s.name), `app: ${s.app} ${s.version}`.trim(), `canvas: ${s.canvas}   fps: ${s.fps ?? '?'}   length: ${fmtShort(s.duration)}`, `file: ${d.file}`, `tracks: ${s.tracks.map((t) => `${t.n}=${t.type}(${t.segments})`).join(' ')}`, `media: ${s.media}   subtitles: ${s.subtitles}`, ...s.warnings.map((w) => c.yel('! ' + w))].join('\n')); return 0; }
      case 'tracks': { const d = openDraft(need(1, 'draft')); const s = summarize(d); emit(s.tracks, () => table(s.tracks.map((t) => [String(t.n), t.type, t.name, String(t.segments)]), ['#', 'TYPE', 'NAME', 'SEGMENTS'])); return 0; }
      case 'segments': { const d = openDraft(need(1, 'draft')); const tr = str('track'); const rows = allSegments(d.json).filter((r) => !tr || r.ti === Number(tr)); const data = rows.map((r) => ({ ref: r.ref, type: r.track.type, start: r.seg.target_timerange?.start, duration: r.seg.target_timerange?.duration, speed: r.seg.speed ?? null, volume: r.seg.volume ?? null, label: segLabel(r, d.json) })); emit(data, () => table(rows.map((r) => [r.ref, r.track.type, fmt(r.seg.target_timerange?.start ?? 0), fmt(r.seg.target_timerange?.duration ?? 0), r.seg.speed != null ? 'x' + r.seg.speed : '', r.seg.volume != null ? String(r.seg.volume) : '', segLabel(r, d.json)]), ['REF', 'TYPE', 'START', 'LENGTH', 'SPEED', 'VOL', 'WHAT'])); return 0; }
      case 'media': { const d = openDraft(need(1, 'draft')); const m = mediaList(d.json); emit(m, () => table(m.map((x) => [x.kind, x.name, fmtShort(x.duration), x.size, String(x.used) + '×', existsSync(x.path) ? x.path : c.red('MISSING ') + x.path]), ['KIND', 'NAME', 'LENGTH', 'SIZE', 'USED', 'PATH'])); return 0; }
      case 'trim': { const d = openDraft(need(1, 'draft')); const r = findSegment(d.json, need(2, 'segment')); const res = trim(d.json, r, { head: tm('head'), tail: tm('tail'), start: tm('start'), end: tm('end'), ripple: flags.ripple === true ? true : undefined }); out(res.message); save(d, 'trim'); return 0; }
      case 'move': { const d = openDraft(need(1, 'draft')); const res = moveTo(d.json, findSegment(d.json, need(2, 'segment')), parseTime(need(3, 'time'))); out(res.message); save(d, 'move'); return 0; }
      case 'shift': { const d = openDraft(need(1, 'draft')); const by = parseTime(need(2, 'amount, e.g. 0.5s or -1s')); const res = shift(d.json, by, { seg: str('seg') ? findSegment(d.json, str('seg')!) : undefined, trackIndex: str('track') ? Number(str('track')) : undefined, from: tm('from') }); out(res.message); save(d, 'shift'); return 0; }
      case 'speed': { const d = openDraft(need(1, 'draft')); const x = Number(need(3, 'speed, e.g. 1.5')); if (!(x > 0)) throw new Error('speed must be a number > 0'); if (x > 1.15 && flags.force !== true) throw new Error('speed above 1.15x looks rushed and distorts voices (project rule); pass --force to override'); const res = setSpeed(d.json, findSegment(d.json, need(2, 'segment')), x, { ripple: flags.ripple === false ? false : true }); out(res.message); save(d, 'speed'); return 0; }
      case 'volume': { const d = openDraft(need(1, 'draft')); const raw = need(3, 'volume'); const v = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw); if (!Number.isFinite(v)) throw new Error('volume must be like 0.5 or 50%'); const res = setVolume(d.json, findSegment(d.json, need(2, 'segment')), v); out(res.message); save(d, 'volume'); return 0; }
      case 'split': { const d = openDraft(need(1, 'draft')); const res = split(d.json, findSegment(d.json, need(2, 'segment')), parseTime(need(3, 'time'))); out(res.message); save(d, 'split'); return 0; }
      case 'delete': { const d = openDraft(need(1, 'draft')); const res = remove(d.json, findSegment(d.json, need(2, 'segment')), { ripple: !!flags.ripple }); out(res.message); save(d, 'delete'); return 0; }
      case 'gaps': { const d = openDraft(need(1, 'draft')); const t = Number(str('track')); if (!t) throw new Error('gaps needs --track N'); const res = closeGaps(d.json, t); out(res.message); save(d, 'close gaps'); return 0; }
      case 'subs': return subsCmd(cmd, flags, { out, c, emit, save, need, str, tm, dry });
      case 'style': case 'template': return styleCmd(verb, cmd, flags, { out, c, emit, save, need, str });
      case 'shorts': {
        if (!haveFfmpeg()) throw new Error('shorts needs ffmpeg and ffprobe on PATH'); const src = resolve(need(1, 'video file')); if (!existsSync(src)) throw new Error('no such file: ' + src);
        const seedD = str('seed') ? openDraft(str('seed')!) : undefined; const mode = (str('mode') ?? (str('subs') ? 'subs' : 'silence')) as 'silence' | 'subs' | 'even'; if (!['silence', 'subs', 'even'].includes(mode)) throw new Error('--mode: silence, subs or even');
        const outRoot = resolve(str('out') ?? defaultRoots().find((r) => existsSync(r)) ?? join(process.cwd(), 'capcut-drafts')); const o = { source: src, outRoot, count: Number(str('count') ?? 3), min: tm('min') ?? 20e6, max: tm('max') ?? 55e6, mode, vertical: !flags.horizontal, subsFile: str('subs'), seed: seedD?.json, seedDir: seedD?.dir };
        if (dry) { out(c.yel(`dry run: would write up to ${o.count} drafts in ${outRoot} using mode ${mode}`)); return 0; }
        const res = makeShorts(o); emit(res, () => res.map((r, i) => `${i + 1}. ${fmt(r.start)} - ${fmt(r.end)}  ${r.subtitles} subtitle(s)  ${r.dir}`).join('\n') + '\n' + c.dim('Preview before opening CapCut: capcut preview <folder>   (fresh drafts are not verified in every CapCut version; see README)')); return 0; }
      case 'new': {
        if (!haveFfmpeg()) throw new Error('new needs ffmpeg and ffprobe on PATH'); const name = need(1, 'project name'); const vid = str('video'); if (!vid) throw new Error('new needs --video file'); const [w, h] = (str('size') ?? '1080x1920').split('x').map(Number) as [number, number]; if (!w || !h) throw new Error('--size like 1080x1920');
        const seedD = str('seed') ? openDraft(str('seed')!) : undefined; const p = probe(resolve(vid)); const j = blankDraft({ name, width: w, height: h, fps: p.fps || 30, seed: seedD?.json }); addVideo(j, p, { at: 0, fill: w < h && p.width > p.height }); const ps = [p]; if (str('audio')) { const a = probe(resolve(str('audio')!)); addAudio(j, a, { at: 0 }); ps.push(a); }
        if (str('subs')) addCues(j, parseCues(readFileSync(resolve(str('subs')!), 'utf8')));
        if (dry) { out(c.yel('dry run: nothing written')); return 0; } const dir = newDraftDir(resolve(str('out') ?? defaultRoots().find((r) => existsSync(r)) ?? join(process.cwd(), 'capcut-drafts')), name); writeNewDraft(dir, j, ps, seedD?.dir); out(c.grn('created') + ' ' + dir); return 0; }
      case 'preview': {
        if (!haveFfmpeg()) throw new Error('preview needs ffmpeg on PATH'); const d = openDraft(need(1, 'draft')); const outFile = resolve(str('out') ?? join(process.cwd(), basename(d.dir) + '_preview.mp4'));
        const r = renderPreview(d.json, { out: outFile, height: Number(str('height') ?? 540), from: tm('from'), to: tm('to'), burnSubs: !flags['no-subs'] }); out(c.grn('preview') + ` ${r.out} (${r.seconds.toFixed(1)}s)`); for (const n of r.notes) out(c.yel('! ' + n)); out(c.dim('Rough check only: effects, filters, transitions, animations and stickers are not rendered.')); return 0; }
      case 'doctor': { const d = openDraft(need(1, 'draft')); const fs = diagnose(d.json); const run = appRunning(); emit({ findings: fs.map(({ fix, ...f }) => f), appRunning: run }, () => (fs.length ? fs.map((f) => (f.level === 'error' ? c.red('error') : f.level === 'warn' ? c.yel('warn ') : c.dim('note ')) + ' ' + f.message + (f.fixable ? c.dim('  [fixable]') : '')).join('\n') + '\n' : c.grn('no problems found') + '\n') + summaryLine(fs) + (run ? '\n' + c.yel(`${run} is running: close it before editing`) : '') + (fs.some((f) => f.fixable) ? '\n' + c.dim('Apply the safe fixes: capcut fix <draft>') : '')); return fs.some((f) => f.level === 'error') ? 2 : 0; }
      case 'fix': { const d = openDraft(need(1, 'draft')); const fs = diagnose(d.json); const done = applyFixes(fs); if (!done.length) { out(c.grn('nothing to fix automatically')); const left = fs.filter((f) => !f.fixable); for (const f of left) out(c.yel('manual: ') + f.message); return 0; } for (const m of done) out('- ' + m); save(d, `${done.length} fix(es)`); for (const f of fs.filter((f) => !f.fixable)) out(c.yel('manual: ') + f.message); return 0; }
      case 'backup': { const d = openDraft(need(1, 'draft')); const b = backupsOf(d); emit(b, () => (b.length ? b.join('\n') : 'no backups yet (one is made on every write)')); return 0; }
      case 'restore': { const d = openDraft(need(1, 'draft')); if (!flags.force) { const r = appRunning(); if (r) throw new DraftError('APP_RUNNING', `${r} is running. Close it first or use --force.`); } if (dry) { out(c.yel('dry run: nothing restored')); return 0; } const name = restoreBackup(d, cmd[2]); out(c.grn('restored') + ' ' + name + c.dim('  (the replaced file was kept as *.pre-restore-*)')); return 0; }
      default: io.err(`unknown command "${verb}". Try: capcut --help`); return 1;
    }
  } catch (e) { const err = e as Error & { code?: string }; io.err(c.red('error: ') + err.message); return err instanceof DraftError ? 3 : 1; }
}

interface Ctx { out: (s: string) => void; c: ReturnType<typeof C>; emit: (d: unknown, t: () => string) => void; save: (d: Draft, w: string) => void; need: (i: number, w: string) => string; str: (k: string) => string | undefined; tm?: (k: string) => number | undefined; dry?: boolean }
function subsCmd(cmd: string[], flags: Args['flags'], x: Ctx): number {
  const sub = ['list', 'set', 'delete', 'replace', 'shift', 'stretch', 'import', 'export', 'tidy'].includes(cmd[1] ?? '') ? cmd[1]! : 'list'; const base = sub === cmd[1] ? 2 : 1;
  const d = openDraft(x.need(base, 'draft')); const j: J = d.json; const a = (i: number, w: string) => x.need(base + i, w);
  switch (sub) {
    case 'list': { const s = subtitles(j); x.emit(s.map((q) => ({ n: q.n, start: q.start, end: q.end, text: q.text })), () => s.length ? table(s.map((q) => [String(q.n), fmt(q.start), fmt(q.end), q.text.replace(/\n/g, ' ⏎ ')]), ['#', 'START', 'END', 'TEXT']) : 'no subtitles (import some: capcut subs import <draft> file.srt)'); return 0; }
    case 'set': editText(j, Number(a(1, 'subtitle number')), a(2, 'new text')); x.save(d, 'subtitle text'); return 0;
    case 'delete': removeSub(j, Number(a(1, 'subtitle number'))); x.save(d, 'subtitle removed'); return 0;
    case 'replace': { const n = replaceText(j, a(1, 'text to find'), a(2, 'replacement'), { regex: !!flags.regex, ignoreCase: !!flags.i }); x.out(`${n} subtitle(s) changed`); if (n) x.save(d, 'replace'); return 0; }
    case 'shift': { const n = retime(j, { by: parseTime(a(1, 'amount')), from: x.tm?.('from') }); x.out(`${n} subtitle(s) moved`); x.save(d, 'subtitle shift'); return 0; }
    case 'stretch': { const f = Number(a(1, 'factor, e.g. 1.05')); if (!(f > 0)) throw new Error('factor must be > 0'); const n = retime(j, { factor: f }); x.out(`${n} subtitle(s) retimed`); x.save(d, 'subtitle stretch'); return 0; }
    case 'import': { const file = resolve(a(1, 'subtitle file')); const cues = parseCues(readFileSync(file, 'utf8')); if (!cues.length) throw new Error('no cues found in ' + file); const r = addCues(j, cues, { offset: x.tm?.('offset'), replace: !!flags.replace }); x.out(`${r.added} cue(s) added to track ${r.track}`); x.save(d, 'subtitle import'); return 0; }
    case 'export': { const cues = exportCues(j); const file = cmd[base + 1]; const f = x.str('format') ?? (file?.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt'); if (f !== 'srt' && f !== 'vtt') throw new Error('--format: srt or vtt'); const text = f === 'vtt' ? toVtt(cues) : toSrt(cues); if (file) { writeFileSync(resolve(file), text); x.out(`${cues.length} cue(s) written to ${resolve(file)}`); } else x.out(text); return 0; }
    case 'tidy': { const n = tidy(j); x.out(`${n} cue(s) adjusted`); if (n) x.save(d, 'subtitle tidy'); return 0; }
  }
  return 0;
}
function styleCmd(kind: 'style' | 'template', cmd: string[], flags: Args['flags'], x: Ctx): number {
  const st = kind === 'style' ? 'styles' : 'templates'; const op = cmd[1];
  if (op === 'list') { const l = listStore(st); x.emit(l, () => (l.length ? l.join('\n') : `no saved ${st} yet`)); return 0; }
  if (op === 'remove') { x.out(removeStore(st, x.need(2, 'name')) ? 'removed' : 'no such ' + kind); return 0; }
  if (op !== 'save' && op !== 'apply') throw new Error(`${kind}: use save, apply, list or remove`);
  const d = openDraft(x.need(2, 'draft')); const name = x.need(3, 'name');
  if (op === 'save') { if (kind === 'style') { const s = pick(d.json, Number(x.str('sub') ?? 1)); x.out('saved ' + saveStyle(d.json, s, name)); } else x.out('saved ' + saveTemplate(d.json, name)); return 0; }
  if (kind === 'style') { const t = readStore<TextStyle>('styles', name); const subs = subtitles(d.json); const sel = x.str('sub') ? [pick(d.json, Number(x.str('sub')))] : subs; x.out(`${applyStyle(d.json, t, sel, { keepPosition: !!flags['keep-position'] })} subtitle(s) styled`); }
  else { const r = applyTemplate(d.json, readStore<Template>('templates', name), { keepCanvas: !!flags['keep-canvas'] }); x.out(`canvas ${r.canvas ? 'changed' : 'kept'}, ${r.styled} subtitle(s) styled`); }
  x.save(d, `${kind} ${name}`); return 0;
}

function quickstart(io: Io, c: ReturnType<typeof C>): number {
  const o = io.out; const ff = haveFfmpeg(); const roots = defaultRoots(); const found = roots.filter((r) => existsSync(r)); const ds = listDrafts();
  o(c.b('capcut quickstart') + '\n');
  o(`${ff ? c.grn('ok  ') : c.yel('warn')} ffmpeg + ffprobe ${ff ? 'found (shorts and preview work)' : 'NOT found: shorts/preview/new need it (apt/brew/winget install ffmpeg)'}`);
  o(`${found.length ? c.grn('ok  ') : c.yel('warn')} draft folders: ${found.length ? found.join(', ') : 'none found. Set CAPCUT_DRAFTS=/path/to/drafts'}`);
  o(`${ds.length ? c.grn('ok  ') : c.yel('info')} ${ds.length} draft(s) found`);
  const app = appRunning(); if (app) o(c.yel(`warn ${app} is running: close it before editing a draft`));
  o('\nTry this, in order:');
  const first = ds[0]?.name ?? 'MyProject'; const q = first.includes(' ') ? `"${first}"` : first;
  [`capcut list`, `capcut info ${q}`, `capcut doctor ${q}`, `capcut subs ${q}`, `capcut subs export ${q} subs.srt`, `capcut speed ${q} 1:1 1.25`, `capcut preview ${q} --out check.mp4`, `capcut shorts long_video.mp4 --count 3`].forEach((s, i) => o(`  ${i + 1}. ${s}`));
  o('\nEvery write makes a backup next to the draft; undo with: capcut restore <draft>');
  o(c.dim('Close CapCut before editing. JianYing 6+ drafts are encrypted and not supported (CapCut International and JianYing <= 5.9 are plain JSON).'));
  return 0;
}
void writeFileSync; void toSrt; void toVtt;
