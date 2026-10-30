import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { which, run } from '../util/proc.ts';
import { pickLocal } from '../analysis/localStt.ts';
import { info, warn } from '../util/log.ts';

export interface ToolState { name: string; ok: boolean; required: boolean; note?: string }

/** What is installed right now (read-only). */
export async function toolReport(cfg: Config): Promise<ToolState[]> {
  const py = await which('python3');
  const pyMod = async (m: string) => py && (await run('python3', ['-I', '-c', `import ${m}`], { timeoutMs: 20_000 }).catch(() => null))?.code === 0;
  const stt = await pickLocal(cfg).catch(() => null);
  return [
    { name: 'ffmpeg', ok: await which('ffmpeg'), required: true },
    { name: 'ffprobe', ok: await which('ffprobe'), required: true },
    { name: 'yt-dlp', ok: await which('yt-dlp'), required: false, note: 'YouTube download' },
    { name: 'speech-to-text', ok: !!stt, required: false, note: 'real titles + word captions (whisper.cpp)' },
    { name: 'edge-tts', ok: await which('edge-tts'), required: false, note: 'voice-over' },
    { name: 'opencv', ok: await pyMod('cv2'), required: false, note: 'speaker-follow crop' },
  ];
}

/**
 * Start-up self-install (owner's request: "project start karte hi jo install hona hai ho jaye"). If something optional/required is missing, run the repo's own
 * `setup.sh` ONCE per 24 h in the background (log: data/bootstrap.log). Pinned versions live in setup.sh / tools/install-whisper-cpp.sh. Switch off: AUTO_INSTALL=0
 * (or config `autoInstall:false`). Never blocks start-up, never touches data/ except the log.
 */
export async function bootstrap(store: Store, cfg: Config, o: { now?: number; spawnSetup?: (script: string, log: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<{ started: boolean; missing: string[]; reason?: string }> {
  const env = o.env ?? process.env; const now = o.now ?? Date.now();
  const missing = (await toolReport(cfg)).filter((t) => !t.ok).map((t) => t.name);
  if (!missing.length) return { started: false, missing };
  if (env.AUTO_INSTALL === '0' || (cfg as { autoInstall?: boolean }).autoInstall === false) return { started: false, missing, reason: 'AUTO_INSTALL=0' };
  const script = join(cfg.rootDir, 'setup.sh'); if (!existsSync(script)) return { started: false, missing, reason: 'setup.sh not found' };
  const last = Number(store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', 'bootstrap:last')?.v ?? 0); if (now - last < 24 * 3600_000) return { started: false, missing, reason: 'already tried in the last 24 h' };
  store.exec(`INSERT INTO kv(k,v) VALUES('bootstrap:last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, String(now));
  const log = join(cfg.dataDir, 'bootstrap.log');
  try { (o.spawnSetup ?? ((s, l) => { const out = openSync(l, 'a'); spawn('sh', [s], { cwd: cfg.rootDir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, SETUP_AUTO: '1' } }).unref(); }))(script, log); info('start-up install started', { missing, log }); return { started: true, missing }; }
  catch (e) { warn('start-up install could not start', { err: (e as Error).message.slice(0, 100) }); return { started: false, missing, reason: (e as Error).message.slice(0, 100) }; }
}
