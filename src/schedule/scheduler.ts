export interface SchedConfig { perDayCap: number; minGapMinutes: number; quietHours: [number, number]; baselineHours: number[]; jitterMinutes: number }
export interface HourStat { hour: number; views: number; samples: number }

/** Hour-of-day in a timezone (IANA), using Intl (no deps). */
export function hourIn(tz: string, d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(d)) % 24;
}
export function dayKey(tz: string, d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const inQuiet = (h: number, q: [number, number]) => (q[0] <= q[1] ? h >= q[0] && h < q[1] : h >= q[0] || h < q[1]);

/**
 * Preferred posting hours: evidence-based when >= minSamples analytics rows exist (top hours by mean views),
 * otherwise the conservative configured baseline. Returns also `basis` so the plan is auditable (measured vs baseline).
 */
export function preferredHours(stats: HourStat[], cfg: SchedConfig, minSamples = 8): { hours: number[]; basis: 'measured' | 'baseline' } {
  const total = stats.reduce((a, s) => a + s.samples, 0);
  if (total < minSamples) return { hours: cfg.baselineHours, basis: 'baseline' };
  const ranked = stats.filter((s) => s.samples > 0 && !inQuiet(s.hour, cfg.quietHours)).sort((a, b) => b.views / b.samples - a.views / a.samples).slice(0, Math.max(cfg.perDayCap, 3)).map((s) => s.hour);
  return ranked.length ? { hours: ranked.sort((a, b) => a - b), basis: 'measured' } : { hours: cfg.baselineHours, basis: 'baseline' };
}

/**
 * Plan publish slots: at most perDayCap/day, minimum gap between any two, never in quiet hours, jittered (not on the dot),
 * and never before `from`. `existing` = already scheduled/published times (counted toward caps). Deterministic given rnd.
 */
export function planSlots(n: number, o: { from: Date; tz: string; cfg: SchedConfig; stats?: HourStat[]; existing?: Date[]; rnd?: () => number; maxDays?: number }): { at: Date; hour: number; basis: 'measured' | 'baseline' }[] {
  const rnd = o.rnd ?? Math.random; const { hours, basis } = preferredHours(o.stats ?? [], o.cfg);
  const taken = [...(o.existing ?? [])].sort((a, b) => a.getTime() - b.getTime());
  const out: { at: Date; hour: number; basis: 'measured' | 'baseline' }[] = [];
  const gap = o.cfg.minGapMinutes * 60_000;
  const perDay = new Map<string, number>();
  for (const d of taken) perDay.set(dayKey(o.tz, d), (perDay.get(dayKey(o.tz, d)) ?? 0) + 1);
  const start = new Date(Math.ceil(o.from.getTime() / 60_000) * 60_000);
  const horizon = (o.maxDays ?? 60) * 24 * 60;
  const candidates: Date[] = [];
  for (let m = 0; m < horizon; m += 15) {
    const t = new Date(start.getTime() + m * 60_000);
    const h = hourIn(o.tz, t);
    const firstTickOfHour = hourIn(o.tz, new Date(t.getTime() - 15 * 60_000)) !== h;
    if (hours.includes(h) && (firstTickOfHour || m === 0)) candidates.push(t);
  }
  for (const base of candidates) {
    if (out.length >= n) break;
    const jit = Math.round((rnd() * 2 - 1) * o.cfg.jitterMinutes) * 60_000;
    const t = new Date(Math.max(base.getTime() + jit, start.getTime()));
    const h = hourIn(o.tz, t);
    if (inQuiet(h, o.cfg.quietHours)) continue;
    const dk = dayKey(o.tz, t);
    if ((perDay.get(dk) ?? 0) >= o.cfg.perDayCap) continue;
    const all = [...taken, ...out.map((x) => x.at)];
    if (all.some((x) => Math.abs(x.getTime() - t.getTime()) < gap)) continue;
    perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
    out.push({ at: t, hour: h, basis });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
