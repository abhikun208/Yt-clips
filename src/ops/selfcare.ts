import { existsSync, readdirSync, readFileSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { freeMb } from '../util/disk.ts';
import { freeUpSpace } from '../util/cleanup.ts';
import { liveChildren } from '../util/proc.ts';
import { notify } from '../notify.ts';
import { deadSttKeyIds, keyId } from '../analysis/stt.ts';
import { sttCandidates } from '../ai/settings.ts';
import { info, warn } from '../util/log.ts';

/**
 * "Survival" tasks for a 24x7 host - nobody should have to look at the server:
 *  1) temp files left by a crashed render/STT are deleted (a long job is never touched: age limit is 3 h when idle, 12 h while a job runs);
 *  2) disk usage > 85 % -> automatic cleanup (same safe order as freeUpSpace) + a Telegram warning (once a day);
 *  3) orphaned ffmpeg/python/whisper/yt-dlp processes (parent died, still burning CPU) are killed after 10 minutes;
 *  4) runtime key sentinel: when EVERY cloud speech-to-text key is dead the owner is told once a day (the system keeps working on local/Gemini).
 */
export function sweepTmp(store: Store, cfg: Config, now = Date.now()): number {
  const running = !!store.get(`SELECT 1 FROM jobs WHERE state='RUNNING'`); const maxAge = (running ? 12 : 3) * 3600_000; let n = 0;
  try { for (const name of readdirSync(cfg.dirs.tmp)) { const f = join(cfg.dirs.tmp, name); try { if (now - statSync(f).mtimeMs > maxAge) { rmSync(f, { recursive: true, force: true }); n++; } } catch { /* raced with a running job */ } } } catch { /* no tmp dir yet */ }
  return n;
}
export function diskUsedPct(path: string): number { try { const s = statfsSync(path); return s.blocks ? Math.round((1 - s.bavail / s.blocks) * 100) : 0; } catch { return 0; } }
export async function diskWatch(store: Store, cfg: Config, limitPct = 85): Promise<{ usedPct: number; freedMb: number }> {
  const used = diskUsedPct(cfg.dataDir); if (used < limitPct) return { usedPct: used, freedMb: 0 };
  const need = freeMb(cfg.dataDir) + 2000; const r = freeUpSpace(store, cfg, need);
  warn('disk almost full - cleaned automatically', { usedPct: used, freedMb: r.freedMb, actions: r.actions.length });
  await notify(store, cfg, `disk:${new Date().toISOString().slice(0, 10)}`, `⚠️ Yt-clips: disk ${used}% bhar gayi. Auto-cleanup ne ${r.freedMb} MB khali kiya (${r.actions.length} files). Agar baar-baar aaye to disk badhao.`);
  return { usedPct: used, freedMb: r.freedMb };
}
const OURS = /(^|\/)(ffmpeg|ffprobe|python3?|whisper-cli|whisper-cpp|yt-dlp)$/;
/** Linux only (/proc). Kills processes that use our data dir, are NOT children we are waiting for, and are older than `minAgeSec`. Returns the killed PIDs. */
export function sweepOrphans(cfg: Config, minAgeSec = 600, opts: { proc?: string; kill?: (pid: number) => void } = {}): number[] {
  const proc = opts.proc ?? '/proc'; if (!existsSync(join(proc, 'self'))) return [];
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL')); const killed: number[] = [];
  let up = 0; try { up = Number(readFileSync(join(proc, 'uptime'), 'utf8').split(' ')[0]); } catch { return []; }
  for (const d of readdirSync(proc)) {
    if (!/^\d+$/.test(d)) continue; const pid = Number(d); if (pid === process.pid || liveChildren.has(pid)) continue;
    try {
      const args = readFileSync(join(proc, d, 'cmdline'), 'utf8').split('\0').filter(Boolean); if (!args.length || !OURS.test(args[0]!)) continue;
      if (!args.some((a) => a.includes(cfg.dataDir))) continue;
      const stat = readFileSync(join(proc, d, 'stat'), 'utf8'); const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // field 22 (starttime) = index 19 after ") "
      const age = up - Number(f[19]) / 100; if (!(age > minAgeSec)) continue;
      kill(pid); killed.push(pid);
    } catch { /* process vanished or unreadable: not ours to judge */ }
  }
  if (killed.length) warn('orphan processes killed (their parent died)', { pids: killed });
  return killed;
}
export async function keySentinel(store: Store, cfg: Config): Promise<boolean> {
  const cands = sttCandidates(cfg); if (!cands.length) return false; const dead = deadSttKeyIds(); if (!cands.every((c) => dead.includes(keyId(c)))) return false;
  warn('ALL cloud speech-to-text keys are rejected', { keys: cands.length });
  await notify(store, cfg, `stt-all-dead:${new Date().toISOString().slice(0, 10)}`, '⚠️ Yt-clips: saari cloud STT keys reject ho rahi hain. System local Whisper / Gemini par chal raha hai (dheere). Nayi key Setup me daal do.');
  return true;
}
export async function selfcareTick(store: Store, cfg: Config): Promise<{ tmp: number; usedPct: number; orphans: number; keysDead: boolean }> {
  const tmp = sweepTmp(store, cfg); const d = await diskWatch(store, cfg); const orphans = sweepOrphans(cfg).length; const keysDead = await keySentinel(store, cfg).catch(() => false);
  if (tmp || orphans || d.freedMb || keysDead) info('selfcare', { tmp, usedPct: d.usedPct, orphans, keysDead });
  return { tmp, usedPct: d.usedPct, orphans, keysDead };
}
