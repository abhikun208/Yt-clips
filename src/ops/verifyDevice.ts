import { writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { freemem, totalmem, arch, release } from 'node:os';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { run } from '../util/proc.ts';
import { realDeps, liveUrl } from '../watcher/live-monitor.ts';
import { probe } from '../media/probe.ts';

/**
 * `npm run cli -- verify-device [--capture]` - run THIS ON THE REAL DEVICE (Android Termux / VPS).
 * Every line is measured on the machine that runs it; nothing is simulated. The result is written to data/device_verification.json and tagged with where it ran,
 * so a report produced in a sandbox can never be mistaken for a Termux verification (`environment.termux` is true only inside Termux).
 * --capture additionally records ~20 s from any source that is live RIGHT NOW (real network, real YouTube) into a temp file, ffprobes it, deletes it.
 */
export interface Check { name: string; status: 'PASS' | 'FAIL' | 'SKIPPED'; detail: string }
export async function verifyDevice(store: Store, cfg: Config, o: { capture?: boolean } = {}): Promise<{ environment: Record<string, unknown>; checks: Check[]; at: string }> {
  const checks: Check[] = []; const add = (name: string, status: Check['status'], detail: string): void => { checks.push({ name, status, detail }); };
  const termux = !!process.env.TERMUX_VERSION || /com\.termux/.test(process.env.PREFIX ?? '');
  const environment = { termux, platform: process.platform, arch: arch(), kernel: release(), node: process.version, ramMB: Math.round(totalmem() / 1048576), freeRamMB: Math.round(freemem() / 1048576) };
  add('node >= 22', Number(process.versions.node.split('.')[0]) >= 22 ? 'PASS' : 'FAIL', process.version);
  for (const [bin, args] of [['ffmpeg', ['-version']], ['ffprobe', ['-version']], ['yt-dlp', ['--version']]] as const) {
    try { const r = await run(bin, [...args], { timeoutMs: 15_000 }); add(bin, r.code === 0 ? 'PASS' : 'FAIL', (r.stdout.split('\n')[0] || r.stderr).trim().slice(0, 80)); } catch (e) { add(bin, 'FAIL', `install nahi hai: ${(e as Error).message.slice(0, 80)}`); }
  }
  const tmp = join(cfg.dirs.tmp, 'verify_device'); mkdirSync(tmp, { recursive: true });
  try {
    const f = join(tmp, 'enc.mp4'); const t0 = Date.now();
    const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f], { timeoutMs: 120_000 });
    if (r.code === 0 && existsSync(f)) { const i = await probe(f); add('encode 3s 540x960 (libx264+aac)', 'PASS', `${((Date.now() - t0) / 1000).toFixed(1)}s, ${i.videoCodec} ${i.width}x${i.height}`); } else add('encode 3s 540x960 (libx264+aac)', 'FAIL', r.stderr.trim().slice(-120));
  } catch (e) { add('encode 3s 540x960 (libx264+aac)', 'FAIL', (e as Error).message.slice(0, 120)); }
  // queue health (real DB of this install)
  const q = store.all<{ state: string; n: number }>('SELECT state, COUNT(*) n FROM jobs GROUP BY state'); const run_ = q.find((x) => x.state === 'RUNNING')?.n ?? 0;
  const stale = store.get<{ n: number }>(`SELECT COUNT(*) n FROM jobs WHERE state='RUNNING' AND lease_until < ?`, Date.now())!.n;
  add('queue: no stale RUNNING job', stale === 0 ? 'PASS' : 'FAIL', `${q.map((x) => `${x.state}=${x.n}`).join(' ') || 'empty'}; stale=${stale}`); void run_;
  const oldest = store.get<{ m: string | null }>(`SELECT MIN(updated_at) m FROM jobs WHERE state IN ('PENDING','RETRY')`)?.m;
  add('queue: oldest pending job', !oldest || Date.now() - Date.parse(oldest.replace(' ', 'T') + 'Z') < 3_600_000 ? 'PASS' : 'FAIL', oldest ? `since ${oldest} UTC` : 'none pending');
  // live detection on the configured sources (REAL yt-dlp -> real YouTube)
  const deps = realDeps(cfg); const live = store.all<{ id: number; uri: string; meta_json: string | null }>(`SELECT id, uri, meta_json FROM sources WHERE kind='youtube_channel' AND status='active'`).filter((s) => { try { return !!JSON.parse(s.meta_json || '{}').watchLive; } catch { return false; } });
  if (!live.length) add('live detection', 'SKIPPED', 'koi source par Live watch ON nahi (Sources tab -> Live)');
  for (const s of live) {
    const p = await deps.probe(liveUrl(s.uri));
    add(`live probe ${s.uri.split('/').slice(-2)[0]}`, p.error ? 'FAIL' : 'PASS', p.live ? 'LIVE abhi' : p.error ? p.reason : 'offline (probe theek kaam kar raha)');
    if (o.capture && p.live) {
      const out = join(tmp, `cap_${s.id}.mp4`); const rec = await deps.record(liveUrl(s.uri), out, 20); let d = rec.reason;
      if (rec.ok && existsSync(out)) { const i = await probe(out); d = `${(statSync(out).size / 1048576).toFixed(1)}MB, ${i.duration.toFixed(1)}s ${i.width}x${i.height}`; }
      add(`live capture 20s ${s.id}`, rec.ok ? 'PASS' : 'FAIL', d); rmSync(out, { force: true });
    } else if (o.capture) add(`live capture 20s ${s.id}`, 'SKIPPED', 'source abhi live nahi - live hone par dobara chalao');
  }
  rmSync(tmp, { recursive: true, force: true });
  const res = { environment, checks, at: new Date().toISOString() };
  try { writeFileSync(join(cfg.dataDir, 'device_verification.json'), JSON.stringify(res, null, 2)); } catch { /* best effort */ }
  return res;
}
