import { createApp, type App } from './app.ts';
import { error, info } from '../util/log.ts';

let app: App;
try { app = createApp(); } catch (e) { error('cannot start', { err: (e as Error).message }); process.exit(1); }
let down = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { if (down) return; down = true; info('shutting down', { sig }); app.stop().then(() => process.exit(0), () => process.exit(1)); });
process.on('unhandledRejection', (e) => error('unhandledRejection', { err: String(e) }));
app.start().catch((e) => { error('failed to start', { err: (e as Error).message }); process.exit(1); });
