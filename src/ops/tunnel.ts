import { spawn, type ChildProcess } from 'node:child_process';
import { info, warn } from '../util/log.ts';

/**
 * Optional HTTPS tunnel for social logins (Meta/TikTok refuse http://127.0.0.1 redirect URIs).
 * Uses `cloudflared` (Termux: `pkg install cloudflared`) quick tunnel: no account, no .env. Off unless YT_CLIPS_TUNNEL=1 (or `npm run cli -- tunnel`).
 * The URL changes on every start -> re-register the redirect URI in the provider dashboard when it changes (a named tunnel/domain avoids that).
 */
let url: string | null = null; let child: ChildProcess | null = null;
export const getTunnelUrl = (): string | null => url;
/** cloudflared also prints https://api.trycloudflare.com (its own API host): that is never the tunnel */
export function parseTunnelUrl(line: string): string | null { return [...line.matchAll(/https:\/\/([a-z0-9-]+)\.(?:trycloudflare\.com|lhr\.life|localhost\.run)\b/gi)].find((m) => !/^(api|www|admin|docs|dash)$/i.test(m[1]!))?.[0] ?? null; }
/** Tries cloudflared first, then plain `ssh` to localhost.run (Termux: `pkg install openssh`) - both give a free https link with no account. */
export async function startTunnel(port: number, bins: string[] = ['cloudflared', 'ssh']): Promise<string | null> {
  if (url) return url;
  for (const b of bins) { const u = await tryOne(port, b); if (u) return u; }
  warn('tunnel: na cloudflared mila na ssh. Termux me chalao: pkg install cloudflared   (ya: pkg install openssh)');
  return null;
}
function tryOne(port: number, bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false; const fin = (v: string | null): void => { if (!done) { done = true; if (!v) { try { child?.kill(); } catch { /* gone */ } child = null; } resolve(v); } };
    try {
      const args = bin === 'ssh' ? ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'] : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', () => fin(null)); child.on('exit', () => { child = null; url = null; fin(null); });
      const on = (b: Buffer): void => { const u = parseTunnelUrl(String(b)); if (u && !url) { url = u; info('https tunnel ready', { url, via: bin }); fin(u); } };
      child.stderr?.on('data', on); child.stdout?.on('data', on);
      setTimeout(() => fin(null), 25_000).unref();
    } catch { fin(null); }
  });
}
export function stopTunnel(): void { try { child?.kill(); } catch { /* gone */ } child = null; url = null; }
