import { dotEnvInfo } from '../env-boot.ts';
import { createApp, type App } from './app.ts';
import { error, info } from '../util/log.ts';

let app: App;
try { app = createApp(); } catch (e) { error('cannot start', { err: (e as Error).message }); process.exit(1); }
let down = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { if (down) return; down = true; info('shutting down', { sig }); app.stop().then(() => process.exit(0), () => process.exit(1)); });
process.on('unhandledRejection', (e) => error('unhandledRejection', { err: String(e) }));
app.start().then(async (port) => {
  if (dotEnvInfo.file) info('.env loaded', { names: dotEnvInfo.names.filter((n) => !/KEY|TOKEN|SECRET|PASS/i.test(n)), secrets: dotEnvInfo.names.filter((n) => /KEY|TOKEN|SECRET|PASS/i.test(n)).length });
  void app.applyEnv?.();
  void app.bootstrap?.();
  const host = process.env.HOST ?? '127.0.0.1'; const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  console.log(`\n  yt-clips ready -> ${url}   (browser mein ye link kholo)\n`);
  if (process.env.AUTO_OPEN !== '0') { const { which, run } = await import('../util/proc.ts'); for (const c of ['termux-open-url', 'xdg-open', 'open']) if (await which(c)) { void run(c, [url], { timeoutMs: 10_000 }).catch(() => {}); break; } }
}).catch((e) => { error('failed to start', { err: (e as Error).message }); process.exit(1); });
