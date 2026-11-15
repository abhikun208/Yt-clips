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
export function parseTunnelUrl(line: string): string | null { return [...line.matchAll(/https:\/\/([a-z0-9-]+)\.(?:trycloudflare\.com|lhr\.life|localhost\.run|serveo\.net)\b/gi)].find((m) => !/^(api|www|admin|docs|dash)$/i.test(m[1]!))?.[0] ?? null; }
/** Order: serveo with a FIXED sub-domain (same https link after every restart -> Meta/TikTok keep working), then cloudflared (random link), then localhost.run (random). */
export async function startTunnel(port: number, name?: string): Promise<string | null> {
  if (url) return url;
  const plan: [string, string?][] = [...(name ? [['ssh', name] as [string, string]] : []), ['cloudflared'], ['ssh']];
  for (const [bin, nm] of plan) { const u = await tryOne(port, bin, nm); if (u) return u; }
  warn('tunnel: na ssh na cloudflared chala. Termux me chalao: pkg install openssh   (ya: pkg install cloudflared)');
  return null;
}
function tryOne(port: number, bin: string, name?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false; const fin = (v: string | null): void => { if (!done) { done = true; if (!v) { try { child?.kill(); } catch { /* gone */ } child = null; } resolve(v); } };
    try {
      const args = bin === 'ssh' ? ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', name ? `${name}:80:127.0.0.1:${port}` : `80:127.0.0.1:${port}`, name ? 'serveo.net' : 'nokey@localhost.run'] : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', () => fin(null)); child.on('exit', () => { child = null; url = null; fin(null); });
      const on = (b: Buffer): void => { const u = parseTunnelUrl(String(b)); if (u && !url) { url = u; info('https tunnel ready', { url, via: name ? 'serveo(fixed name)' : bin }); fin(u); } };
      child.stderr?.on('data', on); child.stdout?.on('data', on);
      setTimeout(() => fin(null), 25_000).unref();
    } catch { fin(null); }
  });
}
export function stopTunnel(): void { try { child?.kill(); } catch { /* gone */ } child = null; url = null; }

/** Stable random sub-domain kept in the DB so the https link is the same after every restart. */
export function tunnelName(store: { get<T>(sql: string, ...a: unknown[]): T | undefined; exec(sql: string, ...a: unknown[]): unknown }): string {
  const k = 'tunnel:name'; const v = store.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v; if (v) return v;
  const n = 'ytc-' + Math.random().toString(16).slice(2, 10); store.exec('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING', k, n); return n;
}
