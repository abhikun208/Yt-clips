import { statfsSync } from 'node:fs';
export function freeMb(path: string): number { const s = statfsSync(path); return Math.floor((s.bavail * s.bsize) / 1048576); }
export function checkDisk(path: string, minFreeMb: number): void {
  const f = freeMb(path);
  if (f < minFreeMb) throw new Error(`LOW_DISK: ${f}MB free < required ${minFreeMb}MB`);
}
