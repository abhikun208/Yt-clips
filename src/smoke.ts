import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { run, which } from './util/proc.ts';
import { llmChain, sttCreds } from './ai/settings.ts';
import { listChannels, ytSecretName } from './channels.ts';
import { secretsFor, tokenFor } from './publish/service.ts';
import { YouTubeAdapter } from './publish/youtube.ts';
import { assertPublishAllowed } from './config.ts';
import { resolveEncoder } from './media/encoder.ts';

export interface SmokeResult { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }
/**
 * REAL-WORLD smoke test. Unlike the unit tests (fake servers), every check here talks to the real service configured on THIS machine.
 * The owner runs it (`npm run cli -- smoke [--url <video-url>] [--upload <file> [--channel <slug>]]`); results are printed, never stored.
 * Nothing is published: --upload sends ONE PRIVATE video (needs gates.publishEnabled) which you delete yourself in YouTube Studio.
 */
export async function runSmoke(store: Store, cfg: Config, o: { url?: string; upload?: string; channel?: string } = {}): Promise<SmokeResult[]> {
  const out: SmokeResult[] = []; const add = (name: string, status: SmokeResult['status'], detail: string) => out.push({ name, status, detail });
  const guard = async (name: string, f: () => Promise<[SmokeResult['status'], string]>) => { try { const [s, d] = await f(); add(name, s, d); } catch (e) { add(name, 'FAIL', String((e as Error).message).slice(0, 200)); } };

  await guard('ffmpeg encode', async () => { const enc = await resolveEncoder(cfg); const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:d=0.5', '-c:v', 'libx264', '-f', 'null', '-'], { timeoutMs: 20_000 }); return [r.code === 0 ? 'PASS' : 'FAIL', `libx264 ok=${r.code === 0}; encoder in use: ${enc}`]; });

  const chain = llmChain(cfg);
  if (!chain.length) add('LLM (Groq/other)', 'SKIP', 'no LLM configured (Setup -> AI)');
  for (const [i, c] of chain.entries()) await guard(`LLM slot ${i + 1} (${new URL(c.baseUrl).host})`, async () => {
    const r = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) }, body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 5, temperature: 0 }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => null) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
    return r.ok && j?.choices?.[0] ? ['PASS', `model ${c.model} answered`] : ['FAIL', `HTTP ${r.status} ${j?.error?.message ?? ''}`.trim()];
  });

  const st = sttCreds(cfg);
  if (!st) add('Speech-to-text API', 'SKIP', 'no STT configured'); else await guard(`STT (${new URL(st.baseUrl).host})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytc-smoke-')); const wav = join(dir, 'tone.wav');
    const g = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1.5', '-ar', '16000', '-ac', '1', wav], { timeoutMs: 15_000 }); if (g.code !== 0) return ['FAIL', 'could not make test audio'];
    const fd = new FormData(); fd.set('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'tone.wav'); fd.set('model', st.model); fd.set('response_format', 'verbose_json');
    const r = await fetch(`${st.baseUrl}/audio/transcriptions`, { method: 'POST', headers: st.apiKey ? { authorization: `Bearer ${st.apiKey}` } : {}, body: fd, signal: AbortSignal.timeout(60_000) });
    return r.ok ? ['PASS', `model ${st.model} accepted audio (a pure tone legitimately transcribes to nothing)`] : ['FAIL', `HTTP ${r.status}`];
  });

  if (!(await which('yt-dlp'))) add('yt-dlp', 'SKIP', 'not installed'); else {
    await guard('yt-dlp version', async () => { const r = await run('yt-dlp', ['--version'], { timeoutMs: 15_000 }); return [r.code === 0 ? 'PASS' : 'FAIL', r.stdout.trim()]; });
    if (o.url) await guard('yt-dlp metadata fetch', async () => { const r = await run('yt-dlp', ['--simulate', '--dump-json', '--no-playlist', '--no-warnings', o.url!], { timeoutMs: 120_000 }); if (r.code !== 0) return ['FAIL', r.stderr.trim().slice(-160)]; const j = JSON.parse(r.stdout.split('\n')[0]!) as { id?: string; duration?: number; heatmap?: unknown[]; is_live?: boolean }; return ['PASS', `id=${j.id} duration=${j.duration}s heatmap=${Array.isArray(j.heatmap) ? j.heatmap.length + ' pts' : 'none'}`]; });
    else add('yt-dlp metadata fetch', 'SKIP', 'pass --url <video link> to test a real fetch');
  }

  const chans = listChannels(store);
  for (const ch of chans) {
    const tp = tokenFor(cfg, ch);
    if (!tp.connected()) { add(`YouTube login (${ch.slug})`, 'SKIP', `not connected (secret ${ytSecretName(ch)})`); continue; }
    await guard(`YouTube login (${ch.slug})`, async () => { const w = await new YouTubeAdapter(store, tp).whoami(); return w ? ['PASS', `channel "${w.title}"`] : ['FAIL', 'token works but no channel on this Google account']; });
  }
  if (o.upload) await guard('YouTube PRIVATE upload', async () => {
    if (!existsSync(o.upload!)) return ['FAIL', 'file not found'];
    assertPublishAllowed(cfg, 'unlisted'); const ch = chans.find((c) => c.slug === (o.channel ?? 'main')); if (!ch) return ['FAIL', 'unknown channel'];
    const ad = new YouTubeAdapter(store, tokenFor(cfg, ch)); const { remoteId } = await ad.upload({ filePath: o.upload!, title: 'yt-clips smoke test (delete me)', description: 'private test upload', tags: [], visibility: 'private', idempotencyKey: `smoke:${Date.now()}` });
    const v = await ad.verify(remoteId); return [v.visibility === 'private' ? 'PASS' : 'FAIL', `uploaded ${remoteId}, processed=${v.processed}, visibility=${v.visibility}. Delete it in YouTube Studio.`];
  });
  else add('YouTube PRIVATE upload', 'SKIP', 'pass --upload <short.mp4> (needs gates.publishEnabled in data/config.json)');
  return out;
}
