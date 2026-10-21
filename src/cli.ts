import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { ingestLocal } from './sources/local.ts';
import { seedJobs, work } from './pipeline.ts';
import { which, run } from './util/proc.ts';
import { freeMb } from './util/disk.ts';
import { planSlots } from './schedule/scheduler.ts';
import { ingestComment } from './comments/comments.ts';

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();

async function doctor(): Promise<number> {
  const checks: [string, boolean, string][] = [];
  const ver = async (c: string, a: string[]) => { try { return (await run(c, a, { timeoutMs: 8000 })).stdout.split('\n')[0] ?? ''; } catch { return ''; } };
  checks.push(['node >= 22.18', Number(process.versions.node.split('.')[0]) > 22 || (process.versions.node.startsWith('22.') && Number(process.versions.node.split('.')[1]) >= 18), process.version]);
  for (const t of ['ffmpeg', 'ffprobe']) checks.push([t, await which(t), await which(t) ? await ver(t, ['-version']) : 'MISSING (required)']);
  checks.push(['yt-dlp (optional: YouTube download)', await which('yt-dlp'), (await which('yt-dlp')) ? 'ok' : 'missing: local files / sidecar only']);
  checks.push(['whisper (optional: transcripts)', (await which('whisper')) || (await which('whisper-cli')), 'else supply .srt/.vtt/.json next to the video']);
  checks.push(['python3+opencv (optional: face tracking)', await which('python3'), 'falls back to centered crop']);
  checks.push(['disk free', freeMb(cfg.dataDir) >= cfg.resources.minFreeDiskMb, `${freeMb(cfg.dataDir)}MB`]);
  const s = new Store(cfg.dbPath);
  checks.push(['database migrates', s.get<{ user_version: number }>('PRAGMA user_version')!.user_version >= 1, cfg.dbPath]);
  const counts = { videos: s.get<{ n: number }>('SELECT count(*) n FROM videos')!.n, candidates: s.get<{ n: number }>('SELECT count(*) n FROM candidates')!.n, clips: s.get<{ n: number }>('SELECT count(*) n FROM clips')!.n };
  checks.push(['safety gates all OFF', !cfg.gates.publishEnabled && !cfg.gates.commentsAutoPost && !cfg.gates.publicVisibilityAllowed, JSON.stringify(cfg.gates)]);
  let bad = 0;
  for (const [n, ok, d] of checks) { const required = !/optional/.test(n) && n !== 'safety gates all OFF'; if (!ok && required) bad++; console.log(`${ok ? 'OK  ' : required ? 'FAIL' : 'WARN'} ${n}: ${d}`); }
  console.log('counts', counts);
  s.close(); return bad ? 1 : 0;
}

async function main(): Promise<number> {
  if (!cmd || cmd === 'help') { console.log('commands: doctor | add <file> [--authorized] | run [maxJobs] | status | plan <n> | comment <platform> <id> <text...>'); return 0; }
  if (cmd === 'doctor') return doctor();
  const s = new Store(cfg.dbPath);
  try {
    if (cmd === 'add') {
      const f = rest.find((a) => !a.startsWith('--')); if (!f) throw new Error('usage: add <file> [--authorized]');
      const r = await ingestLocal(s, cfg, f, { authorized: rest.includes('--authorized') }); console.log(r); return 0;
    }
    if (cmd === 'run') { console.log('seeded', seedJobs(s, cfg)); console.log(await work(s, cfg, { maxJobs: rest[0] ? Number(rest[0]) : undefined })); return 0; }
    if (cmd === 'status') {
      console.log({ videos: s.all('SELECT state, count(*) n FROM videos GROUP BY state'), jobs: s.all('SELECT state, count(*) n FROM jobs GROUP BY state'), clips: s.all('SELECT state, count(*) n FROM clips GROUP BY state'), uploads: s.all('SELECT state, count(*) n FROM uploads GROUP BY state') });
      return 0;
    }
    if (cmd === 'plan') { for (const p of planSlots(Number(rest[0] ?? 3), { from: new Date(), tz: cfg.timezone, cfg: cfg.schedule })) console.log(p.at.toISOString(), `hour=${p.hour}`, p.basis); return 0; }
    if (cmd === 'comment') { const [pl, id, ...t] = rest; console.log(ingestComment(s, pl!, id!, t.join(' '))); return 0; }
    console.error(`unknown command ${cmd}`); return 2;
  } finally { s.close(); }
}
main().then((c) => process.exit(c), (e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
