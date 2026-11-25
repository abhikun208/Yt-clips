import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { publishMode } from '../config.ts';
import { listChannels } from '../channels.ts';
import { adapterFor, youtubeStatus } from './service.ts';
import { autopilotPass } from '../autopilot/engine.ts';
import { editorialQc } from '../analysis/moments-store.ts';
import { sourceAllows, sourceOfClip } from '../accounts/sourcepolicy.ts';

/**
 * "Why is nothing public?" end to end, from REAL stored state only. Every line is a measured fact or a rule that is actually applied by the code;
 * nothing is guessed. Gates and PUBLISH_MODE are owner-only (never writable from the API): the fix text says exactly what the owner must change.
 */
export interface AuditLine { level: 'bad' | 'warn' | 'info' | 'ok'; text: string; fix?: string }
export interface AuditPlatform { channel: string; platform: string; delivery: 'REAL_API' | 'MANUAL_POST' | 'BROKEN'; detail: string }
export interface PublishAudit {
  generatedAt: string; verdict: 'PUBLIC_READY' | 'BLOCKED'; gates: { publishMode: string; publishEnabled: boolean; publicVisibilityAllowed: boolean; autoQueue: boolean; autoApprove: boolean; autopilotRunning: boolean };
  platforms: AuditPlatform[]; uploads: Record<string, number>; stuck: { id: number; clipId: number; channel: string; platform: string; state: string; ageH: number; why: string; fix?: string }[]; neverQueued: { count: number; reasons: Record<string, number> };
  lines: AuditLine[];
}

const HINTS: [RegExp, string, string][] = [
  [/PUBLISH_MODE is DRY_RUN/, 'PUBLISH_MODE DRY_RUN hai: kuch upload nahi hota', 'Project folder ki `.env` me likho: PUBLISH_MODE=PUBLIC  (iske saath publish+public gates aur auto-queue khud khul jaate hain; sirf private chahiye to PRIVATE), phir server restart.'],
  [/PUBLIC_DISABLED: PUBLISH_MODE/, 'PUBLISH_MODE PUBLIC nahi hai', '`.env` me PUBLISH_MODE=PUBLIC karo aur server restart.'],
  [/PUBLISH_DISABLED: gates\.publishEnabled/, 'gates.publishEnabled band hai', '`.env` me PUBLISH_MODE=PUBLIC (ya PRIVATE) likho: gate khud khul jata hai. (data/config.json me gates false likha ho to .env wala jeetta hai.)'],
  [/PUBLIC_DISABLED: gates\.publicVisibilityAllowed/, 'gates.publicVisibilityAllowed band hai', '`.env` me PUBLISH_MODE=PUBLIC likho (gate khud khulta hai) aur restart.'],
  [/AUTH_NOT_CONNECTED|not connected|login|token/i, 'Account connect nahi / token expire', 'Accounts/Settings me us platform ko dobara Connect karo.'],
  [/quota|rateLimit|429/i, 'Platform quota / rate limit', 'Quota reset hone ka intezaar (YouTube: Pacific midnight) ya din ke posts kam karo.'],
  [/SOURCE_POLICY/, 'Source ki upload permission ne roka', 'Sources tab → us source ka "Upload permission" badlo.'],
  [/editorial QC/i, 'Editorial QC hold (kamzor/adhura moment)', 'Clips tab me clip dekho; theek lage to Approve karo.'],
  [/WAIT_SCHEDULE/, 'Schedule ke time ka intezaar', 'Time aate hi apne aap jayega.'],
  [/NEEDS_APPROVAL|manual/i, 'Is platform par manual post flow hai (API permission nahi)', 'Clip file download karke khud post karo, ya API permission/connect poora karo.'],
];
const hint = (err: string | null): { why: string; fix?: string } => { if (!err) return { why: 'koi error nahi, agle loop ka intezaar' }; const h = HINTS.find((x) => x[0].test(err)); return h ? { why: h[1], fix: h[2] } : { why: err.slice(0, 160) }; };

export function publishAudit(store: Store, cfg: Config, now = new Date()): PublishAudit {
  const mode = publishMode(); const lines: AuditLine[] = []; const add = (level: AuditLine['level'], text: string, fix?: string) => lines.push({ level, text, fix });
  const gates = { publishMode: mode, publishEnabled: !!cfg.gates.publishEnabled, publicVisibilityAllowed: !!cfg.gates.publicVisibilityAllowed, autoQueue: !!cfg.automation.autoQueue, autoApprove: !!cfg.automation.autoApprove, autopilotRunning: autopilotPass(store, cfg) };
  if (mode === 'DRY_RUN') add('bad', 'PUBLISH_MODE = DRY_RUN (default): koi bhi platform par kuch upload nahi hota.', HINTS[0]![2]);
  else if (mode === 'PRIVATE') add('warn', 'PUBLISH_MODE = PRIVATE: upload hoga par public nahi.', HINTS[1]![2]);
  if (!gates.publishEnabled) add('bad', 'gates.publishEnabled = false: upload band.', HINTS[2]![2]);
  if (!gates.publicVisibilityAllowed) add('bad', 'gates.publicVisibilityAllowed = false: public visibility band.', HINTS[3]![2]);
  if (!gates.autopilotRunning) add('bad', 'Autopilot paused hai: kuch queue/advance/publish nahi hota.', 'Home → Autopilot → Resume.');
  if (!gates.autoQueue) add('warn', 'automation.autoQueue off: naye clips khud queue nahi hote (sirf jo tumne approve/schedule kiye wo jaate hain).', 'Setup/Automation me autoQueue on karo.');

  const waiting = store.get<{ n: number }>(`SELECT count(*) n FROM uploads WHERE state='UNLISTED_VERIFIED'`)?.n ?? 0;
  if (!gates.autoApprove && waiting) add('bad', `${waiting} upload(s) UNLISTED_VERIFIED par tumhari approval ke intezaar me ruke hain (automation.autoApprove = false): isi wajah se public nahi ho rahe.`, '`.env` me AUTO_APPROVE=true likho aur restart (ya Clips/Publish tab me har clip Approve karo).');
  else if (!gates.autoApprove) add('warn', 'automation.autoApprove = false: har verified clip ko tumhari approval chahiye, tabhi schedule/public hoga.', '`.env` me AUTO_APPROVE=true likho aur restart (ya manually Approve).');
  const platforms: AuditPlatform[] = []; const chans = listChannels(store);
  for (const ch of chans) for (const pf of (ch.config.platforms?.length ? ch.config.platforms : cfg.automation.platforms)) {
    if (pf === 'youtube_shorts' || pf === 'youtube') { try { const ys = youtubeStatus(store, cfg, ch); if (!ys.clientConfigured) { platforms.push({ channel: ch.slug, platform: pf, delivery: 'BROKEN', detail: 'Google OAuth client set nahi' }); add('bad', `${ch.slug}/youtube: Google OAuth client (YT_OAUTH_CLIENT_ID/SECRET) set nahi.`, 'Google Cloud "TVs and Limited Input devices" client banao aur .env me daalo.'); continue; } if (!ys.connected) { platforms.push({ channel: ch.slug, platform: pf, delivery: 'BROKEN', detail: 'YouTube connect nahi / token expire' }); add('bad', `${ch.slug}/youtube: connected nahi (ya token expire): upload nahi ho sakta.`, 'Accounts → YouTube → Connect dobara karo (Google ka code enter karna hota hai).'); continue; } } catch { /* fall through to adapterFor */ } }
    try { const a = adapterFor(store, cfg, pf, ch); const manual = /manual/i.test(a.name); platforms.push({ channel: ch.slug, platform: pf, delivery: manual ? 'MANUAL_POST' : 'REAL_API', detail: manual ? 'API publish permission/login nahi: clip manual-post flow me jaati hai' : `adapter ${a.name}` });
      if (manual) add('warn', `${ch.slug}/${pf}: manual-post flow (khud upload nahi hoga).`, 'Us platform ka login/permission Connect karo.'); }
    catch (e) { const m = (e as Error).message; platforms.push({ channel: ch.slug, platform: pf, delivery: 'BROKEN', detail: m.slice(0, 140) }); add('bad', `${ch.slug}/${pf}: ${hint(m).why}`, hint(m).fix); }
  }
  if (platforms.some((p) => p.platform === 'instagram_reels' && p.delivery === 'REAL_API') && !/^https:\/\//.test(process.env.PUBLIC_URL ?? '')) add('info', 'Instagram: video ko Meta ek public https link se uthata hai. PUBLIC_URL set nahi: server khud tunnel kholta hai (Termux: `pkg install cloudflared` ya `pkg install openssh`). Tunnel na chale to Instagram upload fail hoga (resumable Meta har app ko allow nahi karta).');
  if (!platforms.length) add('bad', 'Kisi channel par koi platform select nahi hai.', 'Channels → Platforms me tick karo.');

  const uploads: Record<string, number> = {}; for (const r of store.all<{ state: string; n: number }>('SELECT state, count(*) n FROM uploads GROUP BY state')) uploads[r.state] = r.n;
  const stuck = store.all<{ id: number; clip_id: number; platform: string; state: string; error: string | null; updated_at: string; scheduled_at: string | null; slug: string | null }>(
    `SELECT u.id, u.clip_id, u.platform, u.state, u.error, u.updated_at, u.scheduled_at, ch.slug FROM uploads u LEFT JOIN channels ch ON ch.id=u.channel_id WHERE u.state NOT IN ('PUBLISHED','CANCELLED') ORDER BY u.updated_at ASC LIMIT 60`)
    .map((u) => { const h = hint(u.error); const ageH = Math.round((now.getTime() - new Date(u.updated_at.replace(' ', 'T') + (u.updated_at.includes('Z') ? '' : 'Z')).getTime()) / 36e5);
      return { id: u.id, clipId: u.clip_id, channel: u.slug ?? 'main', platform: u.platform, state: u.state, ageH: Math.max(0, ageH), why: u.state === 'SCHEDULED_OR_APPROVED' && u.scheduled_at && new Date(u.scheduled_at) > now ? `schedule: ${u.scheduled_at} par jayega` : h.why, ...(h.fix ? { fix: h.fix } : {}) }; });
  const errs: Record<string, number> = {}; for (const s of stuck) if (s.ageH >= 1 && !/schedule:/.test(s.why)) errs[s.why] = (errs[s.why] ?? 0) + 1;
  for (const [w, n] of Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 5)) add('bad', `${n} upload(s) atke: ${w}`, stuck.find((s) => s.why === w)?.fix);

  const ready = store.all<{ id: number; review: string | null }>(`SELECT c.id, c.review FROM clips c WHERE c.qc_pass=1 AND c.edited_path IS NOT NULL AND COALESCE(c.review,'')<>'rejected' AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.clip_id=c.id)`);
  const reasons: Record<string, number> = {}; const bump = (k: string) => { reasons[k] = (reasons[k] ?? 0) + 1; };
  for (const c of ready) { const ed = editorialQc(store, c.id); if (!ed.ok) { bump('editorial QC hold'); continue; } const sp = sourceOfClip(store, c.id); const own = sourceAllows(store, sp, null, 'youtube_shorts'); if (!own.ok) { bump('source permission (own channel off)'); continue; } bump(gates.autoQueue ? 'queue ki baari (agle loop me jayegi)' : 'autoQueue off'); }
  if (ready.length) add(gates.autoQueue ? 'info' : 'warn', `${ready.length} QC-pass clip(s) ka abhi koi upload job nahi: ${Object.entries(reasons).map(([k, n]) => `${k}: ${n}`).join(', ')}`, gates.autoQueue ? undefined : 'autoQueue on karo ya clips ko manually queue karo.');
  const published = uploads.PUBLISHED ?? 0; if (published === 0 && (stuck.length || ready.length)) add('info', 'Abhi tak koi upload PUBLISHED nahi hua.');
  const blocked = lines.some((l) => l.level === 'bad') || mode !== 'PUBLIC';
  if (!blocked && !lines.some((l) => l.level === 'warn')) add('ok', 'Gates, mode aur platforms sab khule hain: queue ke clips apne schedule par public honge.');
  return { generatedAt: now.toISOString(), verdict: blocked ? 'BLOCKED' : 'PUBLIC_READY', gates, platforms, uploads, stuck, neverQueued: { count: ready.length, reasons }, lines };
}
