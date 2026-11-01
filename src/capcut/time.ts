/** All draft times are integer microseconds. Parsers accept what people type in a terminal. */
export const US = 1_000_000;
export const toUs = (sec: number): number => Math.round(sec * US);
export const toSec = (us: number): number => us / US;

/** "1.5" / "1.5s" / "1500ms" / "90" / "1:30" / "00:01:30.250" / "-2s" / raw micros with "us". */
export function parseTime(input: string | number): number {
  if (typeof input === 'number') return toUs(input);
  const s = String(input).trim(); if (!s) throw new Error('empty time');
  let m = /^(-?\d+(?:\.\d+)?)us$/.exec(s); if (m) return Math.round(Number(m[1]));
  m = /^(-?\d+(?:\.\d+)?)ms$/.exec(s); if (m) return Math.round(Number(m[1]) * 1000);
  m = /^(-?\d+(?:\.\d+)?)s?$/.exec(s); if (m) return toUs(Number(m[1]));
  m = /^(-)?(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(s);
  if (m) { const v = (Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]!.replace(',', '.'))); return toUs(m[1] ? -v : v); }
  throw new Error(`cannot read time "${s}" (use 1.5s, 1500ms, 1:30 or 00:01:30.250)`);
}
const p2 = (n: number) => String(n).padStart(2, '0');
/** 00:01:02.500 */
export function fmt(us: number): string {
  const neg = us < 0; let ms = Math.round(Math.abs(us) / 1000); const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000; const m = Math.floor(ms / 60_000); ms -= m * 60_000; const s = Math.floor(ms / 1000); ms -= s * 1000;
  return `${neg ? '-' : ''}${p2(h)}:${p2(m)}:${p2(s)}.${String(ms).padStart(3, '0')}`;
}
export const fmtShort = (us: number): string => { const s = Math.abs(us) / US; return (us < 0 ? '-' : '') + (s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toFixed(1)}s` : `${s.toFixed(2)}s`); };
/** SRT uses a comma, VTT a dot. */
export const fmtCue = (us: number, sep: ',' | '.'): string => fmt(us).replace('.', sep);
