import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { run } from './util/proc.ts';
import { llmSlot, sttCreds } from './ai/settings.ts';
import { getChannel, listChannels } from './channels.ts';
import { secretsFor, tokenFor } from './publish/service.ts';
import { YouTubeAdapter } from './publish/youtube.ts';
import { clientCreds, startDeviceFlow } from './publish/oauth.ts';

/**
 * "Is this key actually working?" — one cheap, read-only request per service (nothing is posted or published).
 * The last result is stored in kv (`conn:<target>`) so the UI keeps showing Connected / Failed after a reload.
 * Targets: llm:1|2|3, stt, telegram, discord, mastodon, notify, youtube:<slug>.
 */
export interface ConnResult { target: string; ok: boolean; detail: string; at: string }
const keyOf = (t: string) => `conn:${t}`;

export function lastResults(store: Store): Record<string, ConnResult> {
  const out: Record<string, ConnResult> = {};
  for (const r of store.all<{ k: string; v: string }>(`SELECT k, v FROM kv WHERE k LIKE 'conn:%'`)) { try { out[r.k.slice(5)] = JSON.parse(r.v) as ConnResult; } catch { /* ignore corrupt row */ } }
  return out;
}
export function forgetResult(store: Store, target: string): void { store.exec('DELETE FROM kv WHERE k=?', keyOf(target)); }

const t = (ms = 15_000) => AbortSignal.timeout(ms);
const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/(bot)?\d{6,}:[\w-]{20,}/g, '[token]').slice(0, 200);

async function check(store: Store, cfg: Config, target: string): Promise<[boolean, string]> {
  const [kind, arg] = target.split(':') as [string, string | undefined];
  const secrets = secretsFor(cfg);
  if (kind === 'llm') {
    const c = llmSlot(cfg, Number(arg ?? 1));
    if (!c) return [false, 'is slot mein koi key/provider save nahi hai'];
    const r = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) }, body: JSON.stringify({ model: c.model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with: ok' }] }), signal: t(30_000) });
    const j = await r.json().catch(() => null) as { choices?: unknown[]; error?: { message?: string } } | null;
    if (r.ok && j?.choices?.length) return [true, `${new URL(c.baseUrl).host} · model ${c.model} ne jawab diya`];
    if (r.status === 401 || r.status === 403) return [false, 'key galat/expired hai (HTTP ' + r.status + ')'];
    if (r.status === 404) return [false, `model "${c.model}" ya URL galat hai (HTTP 404)`];
    if (r.status === 429) return [true, 'key sahi hai (abhi rate-limit lagi hai, HTTP 429)'];
    return [false, `HTTP ${r.status} ${j?.error?.message ?? ''}`.trim()];
  }
  if (kind === 'stt') {
    const s = sttCreds(cfg); if (!s) return [false, 'speech-to-text key save nahi hai'];
    const dir = mkdtempSync(join(tmpdir(), 'ytc-conn-')); const wav = join(dir, 'tone.wav');
    const g = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1.2', '-ar', '16000', '-ac', '1', wav], { timeoutMs: 15_000 }); if (g.code !== 0) return [false, 'ffmpeg nahi chala, test audio nahi ban saka'];
    const fd = new FormData(); fd.set('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'tone.wav'); fd.set('model', s.model); fd.set('response_format', 'verbose_json');
    const r = await fetch(`${s.baseUrl}/audio/transcriptions`, { method: 'POST', headers: s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}, body: fd, signal: t(60_000) });
    if (r.ok) return [true, `${new URL(s.baseUrl).host} · model ${s.model} ne audio liya`];
    return [false, r.status === 401 || r.status === 403 ? `key galat hai (HTTP ${r.status})` : `HTTP ${r.status}`];
  }
  if (kind === 'telegram' || kind === 'notify') {
    const name = arg ? `${kind}-${arg}` : kind; const v = secrets.read<{ botToken?: string; chatId?: string }>(name) ?? (arg ? secrets.read<{ botToken?: string; chatId?: string }>(kind) : null);
    if (!v?.botToken) return [false, 'bot token save nahi hai'];
    const me = await fetch(`https://api.telegram.org/bot${v.botToken}/getMe`, { signal: t() }); const mj = await me.json().catch(() => null) as { ok?: boolean; result?: { username?: string }; description?: string } | null;
    if (!mj?.ok) return [false, `bot token galat hai (${mj?.description ?? 'HTTP ' + me.status})`];
    const ch = await fetch(`https://api.telegram.org/bot${v.botToken}/getChat?chat_id=${encodeURIComponent(v.chatId ?? '')}`, { signal: t() }); const cj = await ch.json().catch(() => null) as { ok?: boolean; result?: { title?: string; username?: string; first_name?: string }; description?: string } | null;
    if (!cj?.ok) return [false, `bot @${mj.result?.username} sahi hai, par chat id nahi mila: ${cj?.description ?? 'HTTP ' + ch.status}. Bot ko channel/group mein admin banao.`];
    return [true, `bot @${mj.result?.username} → ${cj.result?.title ?? cj.result?.username ?? cj.result?.first_name ?? 'chat'}`];
  }
  if (kind === 'discord') {
    const v = secrets.read<{ webhookUrl?: string }>(arg ? `discord-${arg}` : 'discord') ?? secrets.read<{ webhookUrl?: string }>('discord'); if (!v?.webhookUrl) return [false, 'webhook URL save nahi hai'];
    const r = await fetch(v.webhookUrl, { signal: t(), redirect: 'error' }); const j = await r.json().catch(() => null) as { name?: string; channel_id?: string; message?: string } | null;
    return r.ok ? [true, `webhook "${j?.name ?? '?'}" mil gaya`] : [false, r.status === 404 ? 'webhook delete ho chuka ya URL galat hai (404)' : `HTTP ${r.status} ${j?.message ?? ''}`.trim()];
  }
  if (kind === 'mastodon') {
    const v = secrets.read<{ instance?: string; accessToken?: string }>(arg ? `mastodon-${arg}` : 'mastodon') ?? secrets.read<{ instance?: string; accessToken?: string }>('mastodon'); if (!v?.instance || !v.accessToken) return [false, 'instance/token save nahi hai'];
    const r = await fetch(`${v.instance}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${v.accessToken}` }, signal: t(), redirect: 'error' }); const j = await r.json().catch(() => null) as { acct?: string; error?: string } | null;
    return r.ok ? [true, `@${j?.acct}@${new URL(v.instance).host}`] : [false, r.status === 401 ? 'token galat/expired (401)' : `HTTP ${r.status} ${j?.error ?? ''}`.trim()];
  }
  if (kind === 'google-client') {
    const cc = clientCreds(secrets); if (!cc) return [false, 'Google client ID/secret save nahi hai (Setup → Social accounts login → YouTube)'];
    const d = await startDeviceFlow(cc.clientId); return d.user_code ? [true, 'Client ID Google ne accept kiya (login baaki hai: Connect dabao)'] : [false, 'Google ne client ID reject kiya'];
  }
  if (kind === 'youtube') {
    const ch = getChannel(store, arg ?? 'main'); const tp = tokenFor(cfg, ch);
    if (!tp.connected()) return [false, `connect nahi hua (Schedule/Publish tab → Connect). Google client ID/secret pehle Setup mein save karo.`];
    const w = await new YouTubeAdapter(store, tp).whoami(); return w ? [true, `channel "${w.title}"`] : [false, 'login chal gaya par is Google account par YouTube channel nahi hai'];
  }
  return [false, 'unknown target'];
}

export async function testConnection(store: Store, cfg: Config, target: string): Promise<ConnResult> {
  if (!/^(llm(:[123])?|stt|telegram(:[\w-]+)?|notify|discord(:[\w-]+)?|mastodon(:[\w-]+)?|youtube(:[\w-]+)?|google-client)$/.test(target)) throw new Error('invalid: unknown target');
  let ok = false, detail = '';
  try { [ok, detail] = await check(store, cfg, target); } catch (e) { const m = short(e); ok = false; detail = /fetch failed|ENOTFOUND|ECONN|timeout|aborted/i.test(m) ? `server tak pahunch nahi paya (internet/URL?): ${m}` : m; }
  const res: ConnResult = { target, ok, detail, at: new Date().toISOString() };
  store.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')`, keyOf(target), JSON.stringify(res));
  return res;
}

/** Targets worth showing/testing right now (only things that have something saved). */
export function knownTargets(store: Store, cfg: Config): string[] {
  const out: string[] = []; const s = secretsFor(cfg);
  for (const n of [1, 2, 3]) if (llmSlot(cfg, n)) out.push(`llm:${n}`); if (sttCreds(cfg)) out.push('stt');
  for (const n of ['telegram', 'discord', 'mastodon', 'notify']) { try { if (s.read(n)) out.push(n); } catch { /* ignore */ } }
  try { if (clientCreds(s)) out.push('google-client'); } catch { /* ignore */ }
  for (const c of listChannels(store)) { try { if (tokenFor(cfg, c).connected()) out.push(`youtube:${c.slug}`); } catch { /* ignore */ } }
  return out;
}
