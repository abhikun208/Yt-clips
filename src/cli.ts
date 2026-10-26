import { dotEnvInfo } from './env-boot.ts';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { ingestLocal } from './sources/local.ts';
import { seedJobs, work } from './pipeline.ts';
import { which, run } from './util/proc.ts';
import { freeMb } from './util/disk.ts';
import { ingestComment } from './comments/comments.ts';
import { addYoutubeSource, pollSources } from './sources/youtube.ts';
import { transcribeVideo } from './analysis/stt.ts';
import { PRESETS, getPreset } from './edit/captionPresets.ts';
import { updateOwnerConfig } from './config.ts';
import { sttCreds } from './ai/settings.ts';
import { advance, queueUpload, listUploads, youtubeStatus, youtubeConnectStart, youtubeConnectPoll, analyticsProviders, saveTokenFor, platformStatus, automationTick, collectYoutubeComments, postComment, secretsFor } from './publish/service.ts';
import { setCommentStatus } from './comments/comments.ts';
import { startLoopbackFlow, clientCreds } from './publish/oauth.ts';
import { collectAnalytics } from './analytics/collect.ts';
import { importAnalyticsCsv, planFromStore } from './schedule/analytics.ts';
import { readFileSync } from 'node:fs';

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();

async function doctor(): Promise<number> {
  const checks: [string, boolean, string][] = [];
  const ver = async (c: string, a: string[]) => { try { return (await run(c, a, { timeoutMs: 8000 })).stdout.split('\n')[0] ?? ''; } catch { return ''; } };
  checks.push(['node >= 22.18', Number(process.versions.node.split('.')[0]) > 22 || (process.versions.node.startsWith('22.') && Number(process.versions.node.split('.')[1]) >= 18), process.version]);
  for (const t of ['ffmpeg', 'ffprobe']) checks.push([t, await which(t), await which(t) ? await ver(t, ['-version']) : 'MISSING (required)']);
  if (await which('ffmpeg')) {
    const f = (await run('ffmpeg', ['-hide_banner', '-filters'], { timeoutMs: 15000 }).catch(() => null))?.stdout ?? ''; const e = (await run('ffmpeg', ['-hide_banner', '-encoders'], { timeoutMs: 15000 }).catch(() => null))?.stdout ?? '';
    const need: [string, string, string][] = [['subtitles', f, 'captions burn-in (libass)'], ['zoompan', f, 'zoom/beat effects'], ['loudnorm', f, '-14 LUFS'], ['afftdn', f, 'noise reduction'], ['sidechaincompress', f, 'music ducking'], ['gblur', f, 'glow'], ['libx264', e, 'video encode'], ['aac', e, 'audio encode']];
    const miss = need.filter(([n, hay]) => !new RegExp(`\\b${n}\\b`).test(hay)).map(([n, , why]) => `${n} (${why})`);
    checks.push(['ffmpeg has all editing filters/encoders', miss.length === 0, miss.length ? 'MISSING: ' + miss.join(', ') + ' — those editing features will fail/skip' : 'all present']);
    checks.push(['opus/mp3 encoder (optional: API speech-to-text upload size)', /\blibopus\b|\blibmp3lame\b/.test(e), 'else uses aac']);
  }
  checks.push(['speech-to-text (optional, but captions need it)', !!(sttCreds(cfg) || process.env.YT_CLIPS_STT_CMD) || (await which('whisper')) || (await which('whisper-cli')), 'add a free Groq key in the UI (AI keys), or install faster-whisper']);
  checks.push(['yt-dlp (optional: YouTube download)', await which('yt-dlp'), (await which('yt-dlp')) ? 'ok' : 'missing: local files / sidecar only']);
  checks.push(['whisper (optional: transcripts)', (await which('whisper')) || (await which('whisper-cli')), 'else supply .srt/.vtt/.json next to the video']);
  checks.push(['python3+opencv (optional: face tracking)', await which('python3'), 'falls back to centered crop']);
  checks.push(['disk free', freeMb(cfg.dataDir) >= cfg.resources.minFreeDiskMb, `${freeMb(cfg.dataDir)}MB`]);
  const s = new Store(cfg.dbPath);
  checks.push(['database migrates', s.get<{ user_version: number }>('PRAGMA user_version')!.user_version >= 1, cfg.dbPath]);
  const counts = { videos: s.get<{ n: number }>('SELECT count(*) n FROM videos')!.n, candidates: s.get<{ n: number }>('SELECT count(*) n FROM candidates')!.n, clips: s.get<{ n: number }>('SELECT count(*) n FROM clips')!.n };
  checks.push(['safety gates all OFF', !cfg.gates.publishEnabled && !cfg.gates.commentsAutoPost && !cfg.gates.publicVisibilityAllowed, JSON.stringify(cfg.gates)]);
  let bad = 0;
  for (const [n, ok, d] of checks) { const required = !/optional/.test(n) && n !== 'safety gates all OFF'; if (!ok && required) bad++; console.log(`${ok ? 'OK  ' : required ? 'FAIL' : 'WARN'} ${n}: ${d}`); }
  console.log('counts', counts);
  s.close(); return bad ? 1 : 0;
}

async function main(): Promise<number> {
  if (!cmd || cmd === 'help') { console.log('commands: doctor | smoke [--url <video>] [--upload <file> [--channel <slug>]] | add <file> [--authorized] | watch <youtube-url> --authorized | poll | transcribe <videoId> | presets | preset <id> | run [maxJobs] | status | plan <n> | youtube-status | youtube-connect | uploads | queue <clipId> <platform> | advance <uploadId> [--approve] [--at ISO] | analytics-import <csv> | analytics-collect | tick | platforms | set-token <instagram|facebook|tiktok> (token from stdin) | youtube-connect-full | comments | comments-collect | comment-approve <id> | comment-post <id> | comment <platform> <id> <text...> | autopilot status|on|off [--publish] [--approve] [--public] [--review] [--yes]  (server: npm start)'); return 0; }
  if (cmd === 'doctor') return doctor();
  const s = new Store(cfg.dbPath);
  try {
    if (cmd === 'add') {
      const f = rest.find((a) => !a.startsWith('--')); if (!f) throw new Error('usage: add <file> [--authorized]');
      const r = await ingestLocal(s, cfg, f, { authorized: rest.includes('--authorized') }); console.log(r); return 0;
    }
    if (cmd === 'watch') { const u = rest.find((a) => !a.startsWith('--')); if (!u) throw new Error('usage: watch <youtube-url> --authorized'); console.log(addYoutubeSource(s, u, rest.includes('--authorized'))); return 0; }
    if (cmd === 'poll') { console.log(await pollSources(s, cfg)); return 0; }
    if (cmd === 'env-check') {
      console.log(dotEnvInfo.file ? `.env mila: ${dotEnvInfo.names.length} variables (values nahi dikhate)` : '.env nahi mila (project folder mein .env banao: cp .env.ai.example .env)');
      const { applyEnvKeys, envStatus } = await import('./ai/envkeys.ts'); const { testConnection } = await import('./connections.ts'); const { keyShape, CATALOG, fetchModels } = await import('./ai/autodetect.ts');
      const found = envStatus().filter((x) => x.var); if (!found.length) console.log('Koi AI key env mein nahi mili (GROQ_API_KEY=... GEMINI_API_KEY=... OPENROUTER_API_KEY=... XAI_API_KEY=...)');
      for (const f of found) { if (f.provider === 'ollama') continue; const sh = keyShape(process.env[f.var!]!); const c = CATALOG.find((x) => x.id === f.provider)!; const m = await fetchModels(c.base, process.env[f.var!]!.trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '')); console.log(`  ${f.provider}: ${f.var} length=${sh.length} start="${sh.start}"${sh.problems.length ? ' PROBLEM: ' + sh.problems.join(', ') : ''} → /models: ${m.ok ? m.models.length + ' models' : 'HTTP ' + m.status + (m.message ? ' ' + m.message : '')}`); }
      const r = await applyEnvKeys(cfg, { force: true }); let bad = 0;
      for (const x of r) { const t = x.report?.llm ? await testConnection(s, cfg, `llm:${x.report.llm.slot}`) : null; const ok = !!x.report?.ok && (!t || t.ok);
        if (!ok && x.provider === 'ollama') { console.log('• ollama: chal nahi raha (optional). Zaroorat nahi to .env se OLLAMA=1 hata do.'); continue; }
        if (!ok) bad++; console.log(`${ok ? '✓' : '✕'} ${x.provider} (${x.var}) ${ok ? x.report?.llm?.model : ''}`); if (!ok) for (const st of x.report?.steps ?? []) if (!st.ok) console.log(`     - ${st.text}`); if (!ok && t && !t.ok) console.log(`     - test: ${t.detail}`); }
      return bad ? 1 : 0;
    }
    if (cmd === 'token') { const t = process.env.YT_CLIPS_TOKEN; if (t) { console.log('Server login token (YT_CLIPS_TOKEN, aapki .env se):\n' + t); } else { const { randomBytes } = await import('node:crypto'); console.log('Abhi koi token set nahi. Ye apna naya token hai, .env mein ek line daalo aur server restart karo:\n\nYT_CLIPS_TOKEN=' + randomBytes(18).toString('hex') + '\n\nBrowser mein jab login/token maange to yehi daalo. (Sirf apne phone par chalana ho to HOST=127.0.0.1 rakho: token ki zaroorat nahi.)'); } return 0; }
    if (cmd === 'transcribe') { const v = s.get<{ path: string }>('SELECT path FROM videos WHERE id=?', Number(rest[0])); if (!v) throw new Error('unknown video id'); const r = await transcribeVideo(cfg, v.path); console.log({ status: r.status, cues: r.cues.length, engine: r.engine, error: r.error }); return r.status === 'ok' || r.status === 'no_speech' ? 0 : 1; }
    if (cmd === 'presets') { for (const p of PRESETS) console.log(`${p.presetId.padEnd(24)} ${p.mode.padEnd(10)} ${p.tags.join(',')}`); console.log(`${PRESETS.length} presets (+ 'none')`); return 0; }
    if (cmd === 'preset') { const id = rest[0]; if (id !== 'none' && !getPreset(id ?? '')) throw new Error('unknown preset (see: presets)'); updateOwnerConfig(cfg, { edit: { captionPreset: id } }); console.log('default caption preset =', id); return 0; }
    if (cmd === 'run') { console.log('seeded', seedJobs(s, cfg)); console.log(await work(s, cfg, { maxJobs: rest[0] ? Number(rest[0]) : undefined })); return 0; }
    if (cmd === 'status') {
      console.log({ videos: s.all('SELECT state, count(*) n FROM videos GROUP BY state'), jobs: s.all('SELECT state, count(*) n FROM jobs GROUP BY state'), clips: s.all('SELECT state, count(*) n FROM clips GROUP BY state'), uploads: s.all('SELECT state, count(*) n FROM uploads GROUP BY state') });
      return 0;
    }
    if (cmd === 'smoke') {
      const { runSmoke } = await import('./smoke.ts'); const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
      const res = await runSmoke(s, cfg, { url: flag('--url'), upload: flag('--upload'), channel: flag('--channel') });
      for (const r of res) console.log(`${r.status.padEnd(4)} ${r.name}: ${r.detail}`);
      return res.some((r) => r.status === 'FAIL') ? 1 : 0;
    }
    if (cmd === 'youtube-status') { console.log(JSON.stringify(youtubeStatus(s, cfg), null, 2)); return 0; }
    if (cmd === 'youtube-connect') {
      const d = await youtubeConnectStart(s, cfg); console.log(`Open ${d.verification_url} and enter code: ${d.user_code}`);
      const end = Date.now() + d.expires_in * 1000; let wait = Math.max(d.interval, 5) * 1000;
      while (Date.now() < end) { await new Promise((r) => setTimeout(r, wait)); const r = await youtubeConnectPoll(s, cfg); if (r.status === 'ok') { console.log('connected (refresh token stored in data/secrets)'); return 0; } if (r.status === 'denied' || r.status === 'expired') { console.log(r.status); return 1; } if (r.status === 'slow_down') wait += 5000; }
      console.log('timed out'); return 1;
    }
    if (cmd === 'youtube-connect-full') {
      const cc = clientCreds(secretsFor(cfg)); if (!cc) { console.log('set YT_OAUTH_CLIENT_ID / YT_OAUTH_CLIENT_SECRET first (OAuth client type must allow loopback, i.e. "Desktop app")'); return 1; }
      const f = await startLoopbackFlow(secretsFor(cfg), cc); console.log(`Browser (same machine) mein kholo:\n${f.authUrl}\n(VPS par: ssh -L ${f.port}:127.0.0.1:${f.port} user@server)`); await f.done; console.log('connected with comment-reply permission'); return 0;
    }
    if (cmd === 'comments') { console.table(s.all('SELECT id, class, status, substr(text,1,50) text, substr(draft,1,50) draft FROM comments ORDER BY id DESC LIMIT 50')); return 0; }
    if (cmd === 'comments-collect') { console.log(await collectYoutubeComments(s, cfg)); return 0; }
    if (cmd === 'comment-approve') { setCommentStatus(s, Number(rest[0]), 'approve'); console.log('approved'); return 0; }
    if (cmd === 'comment-post') { await postComment(s, cfg, Number(rest[0])); console.log('posted'); return 0; }
    if (cmd === 'autopilot') {
      const sub = rest[0] ?? 'status'; const yes = rest.includes('--yes');
      if (sub === 'on') {
        const patch: Record<string, unknown> = { automation: { autoQueue: true, ...(rest.includes('--review') ? { requireReview: true } : {}) } };
        const risky = ['--publish', '--approve', '--public'].filter((f) => rest.includes(f));
        if (risky.length && !yes) throw new Error(`refusing: ${risky.join(' ')} lets the system upload/publish on its own. Re-run with --yes only if you own the content and the connected account.`);
        if (rest.includes('--publish')) (patch.gates as Record<string, boolean> | undefined) ? ((patch.gates as Record<string, boolean>).publishEnabled = true) : (patch.gates = { publishEnabled: true });
        if (rest.includes('--public')) (patch.gates as Record<string, boolean> | undefined) ? ((patch.gates as Record<string, boolean>).publicVisibilityAllowed = true) : (patch.gates = { publicVisibilityAllowed: true });
        if (rest.includes('--approve')) (patch.automation as Record<string, unknown>).autoApprove = true;
        updateOwnerConfig(cfg, patch); console.log('autopilot ON', JSON.stringify(patch));
      } else if (sub === 'off') { updateOwnerConfig(cfg, { automation: { autoQueue: false, autoApprove: false }, gates: { publishEnabled: false, publicVisibilityAllowed: false, commentsAutoPost: false } }); console.log('autopilot OFF (all gates closed)'); }
      const c2 = loadConfig(); console.log(JSON.stringify({ automation: c2.automation, gates: c2.gates }, null, 2)); return 0;
    }
    if (cmd === 'tick') { console.log(await automationTick(s, cfg)); return 0; }
    if (cmd === 'platforms') { console.table(platformStatus(s, cfg)); return 0; }
    if (cmd === 'title-test') { const t = await import('./publish/titletest.ts'); console.log(JSON.stringify({ tick: await t.titleTestTick(s, cfg), tests: t.listTitleTests(s) }, null, 2)); return 0; }
    if (cmd === 'funnel') { const t = await import('./publish/titletest.ts'); console.log(JSON.stringify(await t.funnelTick(s, cfg), null, 2)); return 0; }
    if (cmd === 'retention-collect') { const { collectRetention } = await import('./publish/service.ts'); console.log(JSON.stringify(await collectRetention(s, cfg), null, 2)); return 0; }
    if (cmd === 'analytics-collect') { console.table(await collectAnalytics(s, analyticsProviders(s, cfg))); return 0; }
    if (cmd === 'set-token') { const t = readFileSync(0, 'utf8').trim(); saveTokenFor(cfg, String(rest[0]), t); console.log('token stored'); return 0; }
    if (cmd === 'uploads') { console.table(listUploads(s)); return 0; }
    if (cmd === 'queue') { console.log('upload id', queueUpload(s, Number(rest[0]), String(rest[1] ?? 'youtube_shorts'))); return 0; }
    if (cmd === 'advance') { const ai = rest.indexOf('--at'); console.log(await advance(s, cfg, Number(rest[0]), { approve: rest.includes('--approve'), scheduledAt: ai >= 0 ? new Date(rest[ai + 1]!) : null })); return 0; }
    if (cmd === 'analytics-import') { console.log(importAnalyticsCsv(s, readFileSync(String(rest[0]), 'utf8'))); return 0; }
    if (cmd === 'plan') { const pl = planFromStore(s, { n: Number(rest[0] ?? 3), tz: cfg.timezone, cfg: cfg.schedule }); console.log(`evidence rows: ${pl.samples}`); for (const p of pl.slots) console.log(p.at.toISOString(), `hour=${p.hour}`, p.basis); return 0; }
    if (cmd === 'comment') { const [pl, id, ...t] = rest; console.log(ingestComment(s, pl!, id!, t.join(' '))); return 0; }
    console.error(`unknown command ${cmd}`); return 2;
  } finally { s.close(); }
}
main().then((c) => process.exit(c), (e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
