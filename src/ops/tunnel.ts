import { spawn, type ChildProcess } from 'node:child_process';
import { info, warn } from '../util/log.ts';

/**
 * Optional HTTPS tunnel for social logins (Meta/TikTok refuse http://127.0.0.1 redirect URIs).
 * Uses `cloudflared` (Termux: `pkg install cloudflared`) quick tunnel: no account, no .env. Off unless YT_CLIPS_TUNNEL=1 (or `npm run cli -- tunnel`).
 * The URL changes on every start -> re-register the redirect URI in the provider dashboard when it changes (a named tunnel/domain avoids that).
 */
let url: string | null = null; let child: ChildProcess | null = null;
export const getTunnelUrl = (): string | null => url;
export function parseTunnelUrl(line: string): string | null { return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line)?.[0] ?? null; }
export function startTunnel(port: number, bin = 'cloudflared'): Promise<string | null> {
  if (child) return Promise.resolve(url);
  return new Promise((resolve) => {
    let done = false; const fin = (v: string | null): void => { if (!done) { done = true; resolve(v); } };
    try {
      child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.on('error', () => { warn('tunnel: cloudflared nahi mila (Termux: pkg install cloudflared)'); child = null; fin(null); });
      child.on('exit', () => { child = null; url = null; fin(null); });
      child.stderr?.on('data', (b: Buffer) => { const u = parseTunnelUrl(String(b)); if (u && !url) { url = u; info('https tunnel ready', { url }); fin(u); } });
      setTimeout(() => fin(null), 30_000).unref();
    } catch { child = null; fin(null); }
  });
}
export function stopTunnel(): void { try { child?.kill(); } catch { /* gone */ } child = null; url = null; }
