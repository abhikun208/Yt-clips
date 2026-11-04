import { spawn } from 'node:child_process';

/** PIDs of children this process started and is still waiting for (the orphan sweep must never touch them). */
export const liveChildren = new Set<number>();
let exitHook = false;
function killAllChildren(): void { for (const pid of liveChildren) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** Run a command (no shell) with timeout. Never throws on non-zero exit; throws only if spawn fails. */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string; maxBuffer?: number } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) liveChildren.add(child.pid); if (!exitHook) { exitHook = true; process.on('exit', killAllChildren); } // parent dies -> its ffmpeg/python children die with it (no zombies)
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < maxBuffer) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < maxBuffer) stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); if (child.pid) liveChildren.delete(child.pid); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); if (child.pid) liveChildren.delete(child.pid); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}

export async function which(cmd: string): Promise<boolean> {
  try {
    const r = await run('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { timeoutMs: 5000 });
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch { return false; }
}
