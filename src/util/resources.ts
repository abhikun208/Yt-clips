import { freemem, totalmem, loadavg, cpus } from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';

/** Resource awareness for a phone-class device: sample memory / load / disk, decide whether heavy work (analysis, render) may start. No promises about speed; just backpressure. */
export interface ResourceSample { memFreeMB: number; memTotalMB: number; load1: number; cpus: number; rssMB: number; diskFreeMB: number | null }
export interface ResourceLimits { minFreeMemMB: number; warnFreeMemMB: number; maxLoadPerCpu: number; minDiskFreeMB: number; warnDiskFreeMB: number }
export const DEFAULT_LIMITS: ResourceLimits = { minFreeMemMB: 150, warnFreeMemMB: 400, maxLoadPerCpu: 2.5, minDiskFreeMB: 500, warnDiskFreeMB: 2000 };
/** Load per core above which no NEW heavy job starts (phone is already drowning). pipeline.ts lets one job through after 10 min so a permanently busy device never stalls forever. */
export const OVERLOAD_PER_CPU = 4;
export type Level = 'ok' | 'warn' | 'critical';
export interface Assessment { level: Level; allowHeavy: boolean; maxLanes: number; reasons: string[] }

export function sampleResources(dir = '.', over: Partial<ResourceSample> = {}): ResourceSample {
  let memFree = freemem(); try { const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8')); if (m) memFree = Number(m[1]) * 1024; } catch { /* non-linux */ } // MemAvailable counts reclaimable cache (freemem() understates it)
  let disk: number | null = null; try { const s = statfsSync(dir); disk = Math.round((s.bavail * s.bsize) / 1048576); } catch { /* unknown */ }
  return { memFreeMB: Math.round(memFree / 1048576), memTotalMB: Math.round(totalmem() / 1048576), load1: +loadavg()[0]!.toFixed(2), cpus: Math.max(4, cpus().length), /* Android/Termux often reports 1 core for an 8-core phone */ rssMB: Math.round(process.memoryUsage().rss / 1048576), diskFreeMB: disk, ...over };
}
export function assess(s: ResourceSample, l: ResourceLimits = DEFAULT_LIMITS): Assessment {
  const reasons: string[] = []; const rank = { ok: 0, warn: 1, critical: 2 }; let level: Level = 'ok'; const bump = (x: Level) => { if (rank[x] > rank[level]) level = x; };
  if (s.memFreeMB < l.minFreeMemMB) { bump('critical'); reasons.push(`free memory ${s.memFreeMB} MB < ${l.minFreeMemMB} MB`); } else if (s.memFreeMB < l.warnFreeMemMB) { bump('warn'); reasons.push(`free memory low (${s.memFreeMB} MB)`); }
  if (s.load1 / s.cpus > OVERLOAD_PER_CPU) { bump('critical'); reasons.push(`CPU overloaded (${s.load1} on ${s.cpus} cores): heavy work waits to cool down`); } else if (s.load1 / s.cpus > l.maxLoadPerCpu) { bump('warn'); reasons.push(`CPU load ${s.load1} on ${s.cpus} cores`); }
  if (s.diskFreeMB !== null) { if (s.diskFreeMB < l.minDiskFreeMB) { bump('critical'); reasons.push(`disk free ${s.diskFreeMB} MB < ${l.minDiskFreeMB} MB`); } else if (s.diskFreeMB < l.warnDiskFreeMB) { bump('warn'); reasons.push(`disk free low (${s.diskFreeMB} MB)`); } }
  return { level, allowHeavy: rank[level] < 2, maxLanes: rank[level] === 0 ? 6 : 1, reasons };
}
