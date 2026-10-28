import { existsSync } from 'node:fs';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { freeMb } from './util/disk.ts';

export interface WhyItem { level: 'ok' | 'info' | 'warn' | 'bad'; text: string; fix?: string }

/** "Why is nothing happening?" — walks source → video → analysis → clip → metadata → upload and says, per item, what it is waiting for or what broke. */
export function whyReport(store: Store, cfg: Config, o: { running?: boolean; ytdlp?: boolean } = {}): WhyItem[] {
  const out: WhyItem[] = []; const add = (level: WhyItem['level'], text: string, fix?: string) => out.push({ level, text, fix });
  if (o.running === false) add('warn', 'Worker loop band hai (server AUTO_RUN=0 ya abhi ruka hua).', 'Home → "Run now" dabao ya server ko AUTO_RUN=1 ke saath restart karo.');
  const mb = freeMb(cfg.dataDir); if (mb < cfg.resources.minFreeDiskMb) add('bad', `Disk kam hai: ${mb} MB free (< ${cfg.resources.minFreeDiskMb} MB). Render ruk jayega.`, 'Purani clips delete karo ya storage badhao.');
  const srcs = store.all<{ id: number; kind: string; uri: string; status: string; meta_json: string | null }>(`SELECT id, kind, uri, status, meta_json FROM sources ORDER BY id DESC LIMIT 40`);
  if (!srcs.length) add('warn', 'Koi source hi nahi hai.', 'Home → "Video add karo" ya channel link daalo.');
  const by = (st: string) => srcs.filter((s) => s.status === st);
  for (const s of by('failed').slice(0, 5)) { let r = ''; try { r = (JSON.parse(s.meta_json ?? '{}') as { reason?: string }).reason ?? ''; } catch { /* */ } add('bad', `Source fail: ${s.uri.slice(0, 70)} ${r ? '— ' + r : ''}`, 'Home → sources list mein "↻ Dobara try".'); }
  for (const s of by('skipped').slice(0, 3)) { let r = ''; try { r = (JSON.parse(s.meta_json ?? '{}') as { reason?: string }).reason ?? ''; } catch { /* */ } add('warn', `Source skip hui: ${s.uri.slice(0, 70)} ${r ? '— ' + r : ''}`, 'Setup → YouTube settings mein max duration badhao.'); }
  const pend = srcs.filter((s) => s.kind === 'youtube_video' && s.status === 'pending').length;
  if (pend) add(o.ytdlp === false ? 'bad' : 'info', `${pend} YouTube video download ke intezaar mein.`, o.ytdlp === false ? 'yt-dlp install nahi hai: pip install -U yt-dlp' : 'Agla poll/"Abhi check karo" par download hongi.');
  const vids = store.all<{ id: number; state: string; path: string; error: string | null; analysis_path: string | null }>(`SELECT id, state, path, error, analysis_path FROM videos ORDER BY id DESC LIMIT 30`);
  for (const v of vids) {
    const name = v.path.split('/').pop()!.slice(0, 40);
    if (v.state === 'FAILED' || v.error) { add('bad', `Video #${v.id} (${name}) fail: ${(v.error ?? '').slice(0, 140)}`, 'Home → Failed jobs dekho; "reanalyze" try karo.'); continue; }
    if (!existsSync(v.path)) { add('bad', `Video #${v.id} ki file gayab hai: ${name}`, 'File dobara add karo.'); continue; }
    const c = store.get<{ n: number; r: number }>(`SELECT count(*) n, sum(status='rendered') r FROM candidates WHERE video_id=? AND status<>'superseded'`, v.id) ?? { n: 0, r: 0 };
    if (v.state === 'ANALYZED' && c.n === 0) add('warn', `Video #${v.id} (${name}): analysis ne 0 clip nikale.`, 'Bohot chhota/kam bolchaal wala ya minScore zyada. Setup mein clip.minScore kam karo ya `reanalyze <id> --length 30-60`.');
    else if (v.state === 'NEW' || v.state === 'ANALYZING') add('info', `Video #${v.id} (${name}) analysis queue mein hai.`);
  }
  const jobs = store.all<{ kind: string; state: string; n: number }>(`SELECT kind, state, count(*) n FROM jobs GROUP BY kind, state`);
  const dead = jobs.filter((j) => j.state === 'DEAD' || j.state === 'FAILED'); for (const j of dead) add('bad', `${j.n} ${j.kind} job(s) ${j.state}`, 'Home → Pipeline map → us step par dabao, error dikhega.');
  const waiting = jobs.filter((j) => ['PENDING', 'RETRY', 'RUNNING'].includes(j.state)).reduce((x, y) => x + y.n, 0); if (waiting) add('info', `${waiting} job(s) chal rahe / line mein hain.`);
  const clips = store.get<{ n: number; g: number; rv: number }>(`SELECT count(*) n, sum(metadata_json LIKE '%sabse khaas moment%' OR metadata_json LIKE '%Josh Wala Moment%' OR metadata_json LIKE '%no transcript%' OR json_extract(metadata_json,'$.generic')=1) g, sum(review='pending') rv FROM clips`) ?? { n: 0, g: 0, rv: 0 };
  if (clips.g) add('warn', `${clips.g} clip(s) ka title/description generic hai (asli bolchaal par nahi bana).`, 'Terminal: npm run cli -- remeta   (YouTube par bhi badalna ho: --push). Phir: STT/whisper chal raha hai check karo (cli local-check).');
  if (clips.rv) add('info', `${clips.rv} clip(s) tumhare review ke intezaar mein.`);
  if (!out.some((x) => x.level === 'bad' || x.level === 'warn')) add('ok', vids.length ? 'Koi rukawat nahi mili.' : 'Abhi koi video nahi: pehle source add karo.');
  return out;
}
