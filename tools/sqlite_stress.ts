// Real multi-process stress of the job queue (WAL + busy_timeout): N worker processes enqueue AND claim concurrently on one DB file.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { Store, enqueue, claim } from '../src/db.ts';
if (process.argv[2] === 'child') {
  const [, , , path, id, n] = process.argv; const s = new Store(path!); let ok = 0, err = 0, claimed = 0;
  for (let i = 0; i < Number(n); i++) { try { if (enqueue(s, 'meta', `w${id}:${i}`)) ok++; if (claim(s)) claimed++; } catch { err++; } }
  console.log(JSON.stringify({ ok, err, claimed })); process.exit(0);
}
const path = join(mkdtempSync(join(tmpdir(), 'q-')), 'db.sqlite'); new Store(path); // create + migrate once
const P = Number(process.env.P ?? 8), N = Number(process.env.N ?? 300), t0 = Date.now();
const outs = await Promise.all(Array.from({ length: P }, (_, i) => new Promise<string>((res) => { const c = spawn('node', [process.argv[1]!, 'child', path, String(i), String(N)]); let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => res(o)); })));
const r = outs.map((o) => JSON.parse(o.trim().split('\n').pop()!)); const sum = (k: string) => r.reduce((a: number, x: any) => a + x[k], 0);
const sec = (Date.now() - t0) / 1000; console.log(`processes ${P} x ${N} ops: enqueued ${sum('ok')}, claimed ${sum('claimed')}, ERRORS ${sum('err')}, ${(P * N * 2 / sec).toFixed(0)} writes/s, ${sec.toFixed(1)} s`);
