import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Store } from '../db.ts';
import type { Config } from '../config.ts';
import { freeMb } from '../util/disk.ts';
import { freeUpSpace } from '../util/cleanup.ts';
import { which } from '../util/proc.ts';
import { listChannels } from '../channels.ts';
import { advance, rescanPublished, remetaClips, healGenericMetadata, youtubeStatus, platformStatus } from '../publish/service.ts';
import { repairVideo, DECODE_ERR } from './repair.ts';
import { notify } from '../notify.ts';
import { info } from '../util/log.ts';

export interface DoctorItem { area: string; problem: string; action: string; result: 'fixed' | 'deferred' | 'manual' | 'ok' }
export interface DoctorReport { at: string; items: DoctorItem[]; fixed: number; manual: number; deferred: number }

/** Error text → what to do. First match wins. `retry` = fix is "try again"; `meta` = rebuild metadata first; `defer` = wait (hours); `manual` = only the owner can fix. */
export const UPLOAD_RULES: { re: RegExp; kind: 'meta' | 'retry' | 'defer' | 'manual'; hours?: number; why: string }[] = [
  { re: /INVALID_REQUEST_METADATA|invalidTags|invalidTitle|invalidDescription|invalidLanguage|invalid.*(?:title|tags|description)|defaultLanguage/i, kind: 'meta', why: 'platform rejected the metadata → rebuilt from the clip speech (language code, tags, title, description sanitised) and retried' },
  { re: /QUOTA_EXCEEDED|quotaExceeded|dailyLimitExceeded/i, kind: 'defer', hours: 8, why: 'daily API quota used up → retry after the Pacific-time reset' },
  { re: /uploadLimitExceeded|exceeded the number of videos/i, kind: 'defer', hours: 24, why: 'channel upload limit reached → retry tomorrow (verify the channel with a phone number in YouTube to raise it)' },
  { re: /AUTH_|invalid_grant|unauthorized|token.*(?:expired|revoked)|insufficientPermissions|forbidden|HTTP 40[13]\b/i, kind: 'manual', why: 'login/permission problem → reconnect this account (Schedule tab → Connect) — only the owner can approve a login' },
  { re: /network error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|HTTP 5\d\d|timeout|timed out/i, kind: 'retry', why: 'temporary network/platform error → retried with backoff' },
  { re: /HELD_RESTRICTED/, kind: 'manual', why: 'YouTube itself reports a region block/rejection on the unlisted video → kept private for the owner (check Studio → Copyright; use ⚠️ Claim aaya on the clip)' },
  { re: /processingFailed|rejected|duplicate|copyright|claim/i, kind: 'manual', why: 'platform refused the video itself (processing/duplicate/copyright) → needs a human decision; nothing is bypassed' },
];

const kvGet = (s: Store, k: string) => s.get<{ v: string }>('SELECT v FROM kv WHERE k=?', k)?.v;
const kvSet = (s: Store, k: string, v: string) => s.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v);

/**
 * Auto-doctor: finds what is broken across every channel/platform + the pipeline and fixes what code CAN fix, and says plainly what only the
 * owner can (logins, copyright decisions). It never touches the publish/public/comment gates and never bypasses a platform decision.
 */
export async function runDoctor(store: Store, cfg: Config, o: { fix?: boolean; now?: number; spawnInstall?: (script: string, log: string) => void; repair?: typeof repairVideo } = {}): Promise<DoctorReport> {
  const fix = o.fix !== false; const now = o.now ?? Date.now(); const items: DoctorItem[] = [];
  const add = (area: string, problem: string, action: string, result: DoctorItem['result']) => items.push({ area, problem, action, result });

  // 1) machine health
  const mb = freeMb(cfg.dataDir);
  if (mb < cfg.resources.minFreeDiskMb + 300) { if (fix) { const r = freeUpSpace(store, cfg, cfg.resources.minFreeDiskMb + 500); add('disk', `only ${mb} MB free`, `cleaned ${r.freedMb} MB (${r.actions.length} files)`, r.freedMb > 0 ? 'fixed' : 'manual'); } else add('disk', `only ${mb} MB free`, 'run with fix to clean', 'manual'); }
  for (const t of ['ffmpeg', 'ffprobe']) if (!(await which(t))) add('tools', `${t} missing`, 'install ffmpeg (pkg install ffmpeg / apt install ffmpeg)', 'manual');

  // 2) account connections (per channel / platform)
  for (const ch of listChannels(store)) { if (ch.archived) continue; try { const y = youtubeStatus(store, cfg, ch); if (ch.config.platforms?.includes('youtube_shorts') !== false && !y.connected) add('accounts', `YouTube not connected for "${ch.name}"`, 'Schedule tab → Connect YouTube', 'manual'); } catch { /* ignore */ } }
  for (const p of platformStatus(store, cfg)) if (!p.analyticsConnected && cfg.automation.platforms.includes(p.platform)) add('accounts', `${p.platform} not connected`, 'Setup/Schedule → connect (or use manual post tasks)', 'manual');

  // 3) failed uploads → classify → fix
  for (const u of store.all<{ id: number; clip_id: number; platform: string; error: string | null; state: string }>(`SELECT id, clip_id, platform, error, state FROM uploads WHERE state='FAILED' AND remote_id IS NULL ORDER BY id LIMIT 30`)) {
    const err = u.error ?? ''; const rule = UPLOAD_RULES.find((r) => r.re.test(err)); const tk = `doctor:tries:${u.id}`; const tries = Number(kvGet(store, tk) ?? 0); const dk = `doctor:defer:${u.id}`;
    const area = `upload #${u.id} (${u.platform})`; const msg = err.slice(0, 120);
    const until = Number(kvGet(store, dk) ?? 0); if (until > now) { add(area, msg, `waiting until ${new Date(until).toISOString().slice(0, 16)}Z`, 'deferred'); continue; }
    if (!rule) { if (tries >= 2) { add(area, msg, 'unknown error after 2 automatic retries → needs a look (Publish tab shows the full error)', 'manual'); continue; } }
    else if (rule.kind === 'manual') { add(area, msg, rule.why, 'manual'); continue; }
    else if (rule.kind === 'defer') { kvSet(store, dk, String(now + (rule.hours ?? 8) * 3600_000)); add(area, msg, rule.why, 'deferred'); continue; }
    if (tries >= 5) { add(area, msg, 'gave up after 5 automatic attempts', 'manual'); continue; }
    if (!fix) { add(area, msg, rule?.why ?? 'would retry', 'manual'); continue; }
    kvSet(store, tk, String(tries + 1));
    try {
      if (rule?.kind === 'meta') await remetaClips(store, cfg, { clipIds: [u.clip_id] });
      const r = await advance(store, cfg, u.id); add(area, msg, `${rule?.why ?? 'retried'} → now ${(r as { state: string }).state}${'blocked' in r ? ` (${(r as { blocked: string }).blocked.slice(0, 60)})` : ''}`, 'fixed');
    } catch (e) { add(area, msg, `retry failed: ${(e as Error).message.slice(0, 100)}`, 'manual'); }
  }

  // 3b) the owner deleted the video on the platform: stop trying (terminal), say so
  for (const u of store.all<{ id: number; platform: string; state: string; error: string | null }>(`SELECT id, platform, state, error FROM uploads WHERE remote_id IS NOT NULL AND error LIKE 'remote video % not found%' AND state NOT IN ('QC_FAILED','PUBLISHED')`)) {
    if (fix) { store.exec(`UPDATE uploads SET state='QC_FAILED', error='deleted on the platform (by the owner) — upload cancelled', updated_at=datetime('now') WHERE id=?`, u.id); store.logState('upload', u.id, u.state, 'QC_FAILED', 'remote video deleted'); }
    add(`upload #${u.id} (${u.platform})`, (u.error ?? '').slice(0, 100), fix ? 'video no longer exists on the platform → upload closed (queue the clip again if you want it re-posted)' : 'would close the upload', fix ? 'fixed' : 'manual');
  }

  // 4) dead jobs with a transient cause → one more go (after the disk/network fix above)
  for (const j of store.all<{ id: number; kind: string; key: string; last_error: string | null }>(`SELECT id, kind, key, last_error FROM jobs WHERE state='DEAD' OR (state='RETRY' AND kind='render' AND last_error LIKE '%AV1%') ORDER BY id DESC LIMIT 20`)) {
    const e = j.last_error ?? '';
    if (j.kind === 'meta' && /unknown clip/.test(e)) { if (fix) { store.exec(`UPDATE jobs SET state='DONE', last_error=NULL, updated_at=datetime('now') WHERE id=?`, j.id); add('job meta', e.slice(0, 60), 'the clip was deleted → job closed', 'fixed'); } continue; }
    if (j.kind === 'render' && DECODE_ERR.test(e)) { // the stored source cannot be decoded: fetch the same video again as H.264 (once a day per video)
      const cand = store.get<{ video_id: number }>('SELECT video_id FROM candidates WHERE id=?', Number(j.key.split(':')[1])); const rk = `doctor:repair:${cand?.video_id}`;
      if (!cand) { if (fix) store.exec(`UPDATE jobs SET state='DONE', last_error=NULL WHERE id=?`, j.id); continue; }
      if (now - Number(kvGet(store, rk) ?? 0) < 24 * 3600_000) { continue; }
      if (fix) { kvSet(store, rk, String(now)); const rp = await (o.repair ?? repairVideo)(store, cfg, cand.video_id); add(`video ${cand.video_id}`, 'source cannot be decoded (AV1/corrupt)', rp.note, rp.ok ? 'fixed' : 'manual'); } else add(`video ${cand.video_id}`, 'source cannot be decoded (AV1/corrupt)', 'would re-download as H.264', 'manual');
      continue;
    }
    const k = `doctor:job:${j.id}`; if (Number(kvGet(store, k) ?? 0) >= 2) continue;
    if (/LOW_DISK|ENOSPC|ETIMEDOUT|ECONNRESET|fetch failed|network|timed out|SIGKILL|spawn|rate limit|HTTP 429|HTTP 5\d\d/i.test(e)) {
      if (fix) { store.exec(`UPDATE jobs SET state='PENDING', attempts=0, run_after=0, last_error=NULL, updated_at=datetime('now') WHERE id=?`, j.id); kvSet(store, k, String(Number(kvGet(store, k) ?? 0) + 1)); }
      add(`job ${j.kind}`, e.slice(0, 100), fix ? 'transient cause → job re-queued' : 'would re-queue', fix ? 'fixed' : 'manual');
    } else add(`job ${j.kind}`, e.slice(0, 100), 'not transient → see Home → Pipeline map for the error', 'manual');
  }

  // 5) sources that failed for a transient reason
  for (const s of store.all<{ id: number; uri: string; meta_json: string | null }>(`SELECT id, uri, meta_json FROM sources WHERE status='failed' ORDER BY id DESC LIMIT 15`)) {
    let m: { reason?: string; tries?: number } = {}; try { m = JSON.parse(s.meta_json ?? '{}'); } catch { /* */ } const k = `doctor:src:${s.id}`; const n = Number(kvGet(store, k) ?? 0);
    if (n < 2 && /network|timed? ?out|HTTP 5\d\d|429|unable to download|ECONN|temporar/i.test(m.reason ?? '')) { if (fix) { store.exec(`UPDATE sources SET status='pending' WHERE id=?`, s.id); kvSet(store, k, String(n + 1)); } add('source', `${s.uri.slice(0, 60)}: ${(m.reason ?? '').slice(0, 80)}`, fix ? 're-queued for download' : 'would re-queue', fix ? 'fixed' : 'manual'); }
    else add('source', `${s.uri.slice(0, 60)}: ${(m.reason ?? '').slice(0, 80)}`, n >= 2 ? 'failed again after 2 retries → check the link/yt-dlp' : 'not transient → check the link', 'manual');
  }

  // 5b) speech-to-text availability: without it every clip gets generic metadata and no real captions
  { const st = await import('../analysis/stt.ts'); const { pickLocal } = await import('../analysis/localStt.ts'); const local = await pickLocal(cfg).catch(() => null);
    if (!local && fix && existsSync(join(cfg.rootDir, 'tools', 'install-whisper-cpp.sh')) && now - Number(kvGet(store, 'doctor:whisper-install') ?? 0) > 24 * 3600_000) { // no speech engine at all → build the free offline one once a day, in the background
      kvSet(store, 'doctor:whisper-install', String(now)); const log = join(cfg.dataDir, 'setup-whisper.log');
      try { (o.spawnInstall ?? ((s, l) => { const out = openSync(l, 'a'); spawn('sh', [s, 'base'], { cwd: cfg.rootDir, detached: true, stdio: ['ignore', out, out] }).unref(); }))(join(cfg.rootDir, 'tools', 'install-whisper-cpp.sh'), log); add('speech-to-text', 'no speech-to-text engine installed', `started the free whisper.cpp install in the background (log: ${log}); captions/titles use real speech once it finishes`, 'fixed'); } catch (e) { add('speech-to-text', 'no speech-to-text engine installed', `auto-install could not start: ${(e as Error).message.slice(0, 80)} → run: sh setup.sh`, 'manual'); }
    } else if (!local && st.lastApiSttError && Date.now() - st.lastApiSttError.at < 6 * 3600_000) add('speech-to-text', `cloud STT failed (${st.lastApiSttError.err}) and no local engine is installed → clips get generic title/description and plain captions`, 'install the free offline engine: sh tools/install-whisper-cpp.sh base   (then: npm run cli -- local-check), or fix the server\'s access to the STT API (check key + internet/DNS), then run Home → Generic title/description theek karo', 'manual'); }

  // 6) generic metadata
  const healed = fix ? await healGenericMetadata(store, cfg, 5) : 0; if (healed) add('metadata', 'clips had placeholder title/description', `rebuilt ${healed} from real speech`, 'fixed');

  // 7) post-public rescan (daily): report only
  if (fix) { const sc = await rescanPublished(store, cfg, new Date(now)).catch(() => null); for (const f of sc?.flagged ?? []) add(`public video ${f.remoteId}`, `YouTube reports ${f.why}`, 'nothing changed automatically → check Studio → Copyright; use ⚠️ Claim aaya on the clip if a claim is there', 'manual'); }

  const rep: DoctorReport = { at: new Date(now).toISOString(), items, fixed: items.filter((i) => i.result === 'fixed').length, manual: items.filter((i) => i.result === 'manual').length, deferred: items.filter((i) => i.result === 'deferred').length };
  kvSet(store, 'doctor:last', JSON.stringify(rep));
  if (rep.fixed) info('doctor fixed issues', { fixed: rep.fixed });
  const manual = items.filter((i) => i.result === 'manual'); if (manual.length && fix) void notify(store, cfg, `doctor:${manual.map((m) => m.area + m.problem).join('|').slice(0, 200)}`, `Auto-doctor: ${manual.length} cheez(en) tumhare haath ki hain — ${manual[0]!.area}: ${manual[0]!.action.slice(0, 120)}. Dashboard → Home → 🛠 Doctor.`);
  return rep;
}
export const lastDoctor = (store: Store): DoctorReport | null => { const v = kvGet(store, 'doctor:last'); return v ? JSON.parse(v) : null; };
