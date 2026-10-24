import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { SecretStore } from './publish/secrets.ts';
import { warn } from './util/log.ts';

/**
 * Owner notifications over a Telegram bot (credentials saved via Setup -> "Notifications", secret name `notify`).
 * Best-effort: never throws, never blocks the pipeline, at most once per `key` (kv `notified:<key>`). No secrets in the text.
 * Telegram only talks to the owner's own chat; nothing here posts publicly.
 */
export async function notify(store: Store, cfg: Config, key: string, text: string): Promise<boolean> {
  try {
    if (store.get('SELECT 1 FROM kv WHERE k=?', `notified:${key}`)) return false;
    const cred = SecretStore.forData(cfg.dataDir).read<{ botToken?: string; chatId?: string }>('notify'); if (!cred?.botToken || !cred.chatId) return false;
    const base = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
    const r = await fetch(`${base}/bot${cred.botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: cred.chatId, text: text.slice(0, 3500), disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => null) as { ok?: boolean } | null;
    if (!j?.ok) { warn('notify failed', { status: r.status }); return false; }
    store.exec(`INSERT INTO kv(k,v) VALUES(?, '1') ON CONFLICT(k) DO NOTHING`, `notified:${key}`); return true;
  } catch (e) { warn('notify failed', { err: (e as Error).message.slice(0, 80) }); return false; }
}
