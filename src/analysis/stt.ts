import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Cue } from './transcript.ts';
import { run, which } from '../util/proc.ts';
import { warn, info } from '../util/log.ts';
import { sttCreds, sttCandidates } from '../ai/settings.ts';
import { transcribeViaApi } from './sttApi.ts';
import { transcribeViaGemini } from './geminiStt.ts';
import { llmChain } from '../ai/settings.ts';
import { isTermux, pickLocal, runLocalCli, voiceStudioUrl } from './localStt.ts';

/** Only ONE local model (whisper) may load/run at a time: parallel loads would exhaust RAM on small hosts. Queue is FIFO. */
let localTail: Promise<void> = Promise.resolve();
export let localSttActive = 0, localSttPeak = 0;
export function acquireLocalStt(): Promise<() => void> {
  let rel!: () => void; const mine = new Promise<void>((r) => { rel = r; });
  const wait = localTail; localTail = wait.then(() => mine);
  return wait.then(() => { localSttActive++; localSttPeak = Math.max(localSttPeak, localSttActive); let done = false; return () => { if (done) return; done = true; localSttActive--; rel(); }; });
}
export const resetLocalSttPeak = () => { localSttPeak = 0; };
export interface SttResult { status: 'ok' | 'no_speech' | 'unavailable' | 'failed'; cues: Cue[]; language?: string; engine?: string; error?: string }

/** Engine selection: YT_CLIPS_STT_CMD (custom command: `<cmd> <audio.wav> <model> <lang>` printing the JSON below) else faster-whisper via tools/transcribe.py. */
export async function sttEngine(rootDir: string): Promise<{ cmd: string; args: string[]; name: string } | null> {
  const custom = process.env.YT_CLIPS_STT_CMD?.trim();
  if (custom) { const [cmd, ...args] = custom.split(/\s+/); return { cmd: cmd!, args, name: 'custom' }; }
  if (!(await which('python3'))) return null;
  const probe = await run('python3', ['-I', '-c', 'import faster_whisper'], { timeoutMs: 20_000 }).catch(() => null);
  if (!probe || probe.code !== 0) return null;
  return { cmd: 'python3', args: ['-I', join(rootDir, 'tools', 'transcribe.py')], name: 'faster-whisper' };
}

/** Engines may print log lines before the JSON and may pretty-print it. Try: whole output, then from the first line starting with '{', then the last line. */
function parseLooseJson(out: string): unknown {
  const t = out.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const lines = t.split('\n'); const first = lines.findIndex((l) => l.trimStart().startsWith('{'));
  if (first >= 0) { try { return JSON.parse(lines.slice(first).join('\n')); } catch { /* fall through */ } }
  return JSON.parse(lines[lines.length - 1] ?? '');
}
interface RawSeg { start: number; end: number; text: string; conf?: { logprob?: number; no_speech?: number }; words?: { start: number; end: number; word?: string; text?: string }[] }
/** Validate + normalise engine output. Drops malformed segments/words; never invents timing. */
export function parseSttJson(stdout: string): { cues: Cue[]; language?: string } {
  const j = parseLooseJson(stdout) as { error?: string; language?: string; segments?: RawSeg[] };
  if (j.error) throw new Error(j.error);
  const cues: Cue[] = [];
  for (const s of j.segments ?? []) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start || !String(s.text ?? '').trim()) continue;
    const words = (s.words ?? []).map((w) => ({ start: w.start, end: w.end, text: String(w.word ?? w.text ?? '').trim() })).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.text);
    const cf = s.conf && Number.isFinite(s.conf.logprob) ? { conf: { logprob: s.conf.logprob as number, no_speech: Number.isFinite(s.conf.no_speech) ? (s.conf.no_speech as number) : 0 } } : {};
    cues.push({ start: s.start, end: s.end, text: String(s.text).trim(), ...(words.length ? { words } : {}), ...cf });
  }
  cues.sort((a, b) => a.start - b.start);
  return { cues, language: j.language };
}

/** Last cloud-STT failure in this process (the doctor reports it when no local engine can take over). */
let apiDownAt = 0;
export const resetApiBreaker = () => { apiDownAt = 0; };
export let lastApiSttError: { at: number; err: string } | null = null;
export const noteApiSttError = (err: string) => { lastApiSttError = { at: Date.now(), err: err.slice(0, 120) }; };
/** Extract 16k mono audio, run STT, write the `<video>.json` sidecar the analyzer/captions already read. Never throws: failure => status. */
/** Whisper's own 'auto' detection often calls Hindi/Hinglish speech over music "English" and then invents English sentences (owner's TMKOC clip: "gets away from the water…"). For this owner's content Hindi is the safe default: Hindi speech -> Devanagari -> Hinglish captions; English speech still comes out in Latin letters. Turn off with stt.indiaFirst=false (or set a language per channel). */
/** Whisper's initial prompt: the owner's own words (channel `vocabulary`: character names, brands) make names come out spelled right. */
export const sttPrompt = (cfg: Config, vocab?: string[]): string | undefined => { const base = cfg.stt.prompt; const v = vocab?.length ? `Names and words: ${vocab.join(', ')}.` : ''; return [base, v].filter(Boolean).join(' ') || undefined; };
export const sttLang = (cfg: Config, hint?: string): string => { const l = hint ?? cfg.stt.language; return (!l || l === 'auto') && cfg.stt.indiaFirst !== false ? 'hi' : (l || 'auto'); };
/** Keys the cloud service rejected (401/403/no credits): skipped with growing waits (1 min, 5 min, 1 h) so every clip does not hit them again, yet a topped-up key is used again within minutes; the log says how to fix them. */
const deadKeys = new Map<string, { until: number; n: number }>(); /* exponential backoff 1 min → 5 min → 1 h per key; a successful call resets it, a different key is a different entry */ const BACKOFF_MS = [60_000, 5 * 60_000, 3600_000]; export const keyId = (c: { baseUrl: string; apiKey: string }) => `${c.baseUrl}|${c.apiKey.slice(-6)}`;
export const resetDeadSttKeys = () => deadKeys.clear();
/** How many saved/env cloud STT keys are in back-off right now (the runtime sentinel alerts the owner when ALL of them are). */
export const deadSttKeyIds = (): string[] => [...deadKeys.entries()].filter(([, v]) => v.until > Date.now()).map(([k]) => k);
const fixHint = (host: string): string => /groq/.test(host) ? 'console.groq.com/keys se naya free key banao, .env me GROQ_API_KEY badlo' : /openai/.test(host) ? 'platform.openai.com me credits daalo ya Groq (free) key use karo' : 'is provider ki key/credits check karo';
/** 5-second health probe (GET /models) before a provider gets the audio upload: a dead/slow/rejecting provider costs 5 s, not minutes. Cached per key: 3 min when ok, 30 s when bad; any live failure drops the entry at once. 'net' = no network at all. */
const health = new Map<string, { at: number; v: 'ok' | 'bad' | 'net' }>();
export const resetHealth = () => health.clear();
async function providerHealth(c: { baseUrl: string; apiKey: string }): Promise<'ok' | 'bad' | 'net'> {
  const k = keyId(c); const h = health.get(k); if (h && Date.now() - h.at < (h.v === 'ok' ? 180_000 : 30_000)) return h.v; // 'ok' is trusted 3 min, a bad verdict only 30 s (a provider that flickers is tried again soon)
  let v: 'ok' | 'bad' | 'net';
  try { const r = await fetch(`${c.baseUrl}/models`, { headers: { authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(5000) }); v = r.status === 401 || r.status === 403 ? 'bad' : r.status >= 500 ? 'bad' : 'ok'; /* 404/405 = provider has no /models: not a verdict, try it */ }
  catch (e) { v = /abort|timeout|timed/i.test((e as Error).message + String((e as { name?: string }).name)) ? 'bad' : 'net'; }
  health.set(k, { at: Date.now(), v }); return v;
}
/** A saved Gemini key listens to the audio (approximate timing, repaired locally) - the last line of defence so a bad day for one provider never means no captions. */
async function geminiAudio(cfg: Config, videoPath: string, hint: { language?: string }, why: string): Promise<SttResult | null> {
  for (const g of llmChain(cfg).filter((x) => /generativelanguage\.googleapis\.com/.test(x.baseUrl))) {
    try {
      const t = await transcribeViaGemini(videoPath, cfg.dirs.tmp, g, { language: sttLang(cfg, hint.language) }); if (!t.cues.length) continue;
      const { refineApproxCues } = await import('./align.ts'); const dur = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { timeoutMs: 60_000 })).stdout.trim());
      const ref = await refineApproxCues(cfg.rootDir, cfg.dirs.tmp, videoPath, t.cues, sttLang(cfg, hint.language), dur).catch(() => null);
      if (ref) { t.cues = ref.cues; if (/stable-ts/.test(ref.how)) info('gemini timing refined', { how: ref.how }); else warn('QUALITY REDUCED: caption timing is approximate (stable-ts forced alignment not installed/usable)', { how: ref.how, fix: 'PC/VPS: pip install stable-ts (or use the Docker image + a working cloud/local whisper so Gemini is not needed)' }); }
      info('transcribed', { engine: 'gemini-audio', cues: t.cues.length, why: why.slice(0, 80) }); return { status: 'ok', cues: t.cues, engine: 'gemini-audio' };
    } catch (e) { warn('gemini stt failed', { err: (e as Error).message.slice(0, 120) }); }
  }
  return null;
}
/** Cloud engines first, then local; Gemini audio when they fail OR when the result fails the self-check (hallucination loops, junk words, low engine confidence). */
export async function transcribeVideo(cfg: Config, videoPath: string, hint: { language?: string; prompt?: string } = {}): Promise<SttResult> {
  let r = await transcribeCore(cfg, videoPath, hint);
  const mayGemini = cfg.stt.engine !== 'local' && cfg.stt.engine !== 'api' && !process.env.YT_CLIPS_STT_CMD;
  if ((r.status === 'failed' || r.status === 'unavailable') && mayGemini) { const g = await geminiAudio(cfg, videoPath, hint, `${r.engine ?? 'engines'} failed: ${(r.error ?? r.status).slice(0, 60)}`); if (g) writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(g.cues)); return g ?? r; }
  if (r.status === 'ok') {
    const { checkTranscript } = await import('./sanity.ts'); const q = checkTranscript(r.cues);
    if (q.removed) { info('transcript cleaned: repeated decoder-loop cues removed', { removed: q.removed }); r = { ...r, cues: q.cues }; }
    if (q.badRatio > 0.3 && mayGemini && r.engine !== 'gemini-audio') {
      warn('transcript looks unreliable - trying another engine', { engine: r.engine, badRatio: +q.badRatio.toFixed(2), junkCues: q.bad });
      const g = await geminiAudio(cfg, videoPath, hint, `self-check: ${Math.round(q.badRatio * 100)}% junk cues from ${r.engine}`);
      if (g && checkTranscript(g.cues).badRatio < q.badRatio) { writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(g.cues)); return g; }
    } else if (q.badRatio > 0.3) warn('transcript looks unreliable and no other engine is available', { engine: r.engine, badRatio: +q.badRatio.toFixed(2) });
  }
  return r;
}
async function transcribeCore(cfg: Config, videoPath: string, hint: { language?: string; prompt?: string } = {}): Promise<SttResult> {
  if (!process.env.YT_CLIPS_STT_CMD && cfg.stt.engine !== 'local') {
    const cands = Date.now() - apiDownAt < 10 * 60_000 ? [] : sttCandidates(cfg).filter((c) => (deadKeys.get(keyId(c))?.until ?? 0) < Date.now()); // circuit breaker: after a network failure the cloud engine is skipped for 10 min (no 1-minute wait per clip)
    const alive: typeof cands = []; for (const c of cands) { const h = await providerHealth(c); if (h === 'net') { apiDownAt = Date.now(); break; } if (h === 'ok') alive.push(c); else { const n = deadKeys.get(keyId(c))?.n ?? 0; deadKeys.set(keyId(c), { until: Date.now() + BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]!, n: n + 1 }); warn('STT provider skipped (health check)', { host: (() => { try { return new URL(c.baseUrl).host; } catch { return '?'; } })(), fix: fixHint((() => { try { return new URL(c.baseUrl).host; } catch { return ''; } })()) }); } }
    for (const api of alive) { // saved STT key first, then any other Groq/OpenAI key this install knows: one rejected / out-of-credit key must not silence captions while another works
      try {
        const r = await transcribeViaApi(videoPath, cfg.dirs.tmp, api, { language: sttLang(cfg, hint.language), prompt: hint.prompt ?? cfg.stt.prompt });
        if (!r.cues.length) return { status: 'no_speech', cues: [], engine: 'api', language: r.language };
        deadKeys.delete(keyId(api)); lastApiSttError = null; writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(r.cues)); info('transcribed', { engine: 'api', model: api.model, host: (() => { try { return new URL(api.baseUrl).host; } catch { return '?'; } })(), cues: r.cues.length, language: r.language });
        return { status: 'ok', cues: r.cues, language: r.language, engine: 'api' };
      } catch (e) { health.delete(keyId(api)); noteApiSttError((e as Error).message); warn('api stt failed', { host: (() => { try { return new URL(api.baseUrl).host; } catch { return '?'; } })(), err: (e as Error).message.slice(0, 160), next: alive.indexOf(api) < alive.length - 1 ? 'next key tried' : 'local engine' }); const host0 = (() => { try { return new URL(api.baseUrl).host; } catch { return ''; } })(); if (/AUTH_REVOKED|HTTP 40[13]|no credits|insufficient_quota/i.test((e as Error).message)) { { const n = (deadKeys.get(keyId(api))?.n ?? 0); deadKeys.set(keyId(api), { until: Date.now() + (/no credits|insufficient_quota/i.test((e as Error).message) ? 12 * 3600_000 : BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]!), n: n + 1 }); } warn('STT key band', { host: host0, fix: fixHint(host0) }); } const netErr = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|network|socket|aborted/i.test((e as Error).message + String((e as { cause?: unknown }).cause ?? '')); if (netErr) { apiDownAt = Date.now(); break; } /* offline: no other cloud key can help, go local */ /* key/credit problem: try the next candidate, then a local engine */ if (cfg.stt.engine === 'api' && alive.indexOf(api) === alive.length - 1) return { status: 'failed', cues: [], engine: 'api', error: (e as Error).message.slice(0, 200) }; }
    }
  }
  if (cfg.stt.engine === 'api' && !sttCreds(cfg)) return { status: 'unavailable', cues: [], error: 'stt.engine=api but no API key saved' };
  const pick = await pickLocal(cfg);
  if (pick?.id === 'voicestudio') {
    try {
      const r = await transcribeViaApi(videoPath, cfg.dirs.tmp, { baseUrl: voiceStudioUrl(cfg) + '/v1', apiKey: '', model: cfg.stt.model }, { language: sttLang(cfg, hint.language), prompt: hint.prompt ?? cfg.stt.prompt });
      if (!r.cues.length) return { status: 'no_speech', cues: [], engine: 'voicestudio', language: r.language };
      writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(r.cues)); info('transcribed', { engine: 'voicestudio', cues: r.cues.length });
      return { status: 'ok', cues: r.cues, language: r.language, engine: 'voicestudio' };
    } catch (e) { return { status: 'failed', cues: [], engine: 'voicestudio', error: (e as Error).message.slice(0, 200) }; }
  }
  const eng = pick && (pick.id === 'faster-whisper' || pick.id === 'custom') ? await sttEngine(cfg.rootDir) : pick ? { cmd: '', args: [], name: pick.id } : null;
  if (!eng && cfg.stt.engine !== 'local') { // last resort: a saved Gemini key can listen to audio (approximate timing, labelled engine "gemini-audio")
    const g = llmChain(cfg).find((x) => /generativelanguage\.googleapis\.com/.test(x.baseUrl));
    if (g) { try { const r = await transcribeViaGemini(videoPath, cfg.dirs.tmp, g, { language: sttLang(cfg, hint.language) }); if (!r.cues.length) return { status: 'no_speech', cues: [], engine: 'gemini-audio' }; writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(r.cues)); info('transcribed', { engine: 'gemini-audio', cues: r.cues.length }); return { status: 'ok', cues: r.cues, engine: 'gemini-audio' }; } catch (e) { return { status: 'failed', cues: [], engine: 'gemini-audio', error: (e as Error).message.slice(0, 200) }; } }
  }
  if (!eng) return { status: 'unavailable', cues: [], error: 'no local STT engine (Setup -> Local speech-to-text shows what to install; or add a free Groq key)' };
  // A phone/CPU-only whisper.cpp needs roughly real-time or slower per minute of audio: on a long video the owner saw no output for 8+ minutes and thought the system was dead.
  // When the cloud engine failed and a working Gemini key exists, a LONG video goes to Gemini audio first (approximate timing, repaired locally); local whisper stays the fallback.
  if ((eng.name === 'whisper-cpp' || eng.name === 'whisper-cli') && cfg.stt.engine !== 'local' && cfg.stt.engine !== 'api') {
    const dur = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { timeoutMs: 60_000 })).stdout.trim()) || 0;
    if (dur > (isTermux ? 3 : 8) * 60) { const g = await geminiAudio(cfg, videoPath, hint, `long video (${Math.round(dur / 60)} min) on slow local ${eng.name}`); if (g) { writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(g.cues)); return { status: 'ok', cues: g.cues, engine: 'gemini-audio' } as SttResult; } }
  }
  const release = await acquireLocalStt();
  const t0 = Date.now(); const beat = setInterval(() => info('local STT chal raha hai (kaam ho raha hai, atka nahi)', { engine: eng.name, minutes: Math.round((Date.now() - t0) / 60_000), tip: 'Phone par lamba video slow hota hai. Tez karne ke liye: free Groq/Gemini key sahi rakho ya chhota video do' }), 120_000); beat.unref?.();
  const wav = join(cfg.dirs.tmp, `stt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    const ex = await run('ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeoutMs: 30 * 60_000 });
    if (ex.code !== 0) return { status: 'failed', cues: [], engine: eng.name, error: `audio extraction failed: ${ex.stderr.slice(0, 150)}` };
    let r = { code: 0, stdout: '', stderr: '' }; let parsed: { cues: Cue[]; language?: string };
    try { if (eng.cmd) { r = await run(eng.cmd, [...eng.args, wav, cfg.stt.model, sttLang(cfg, hint.language)], { timeoutMs: 4 * 60 * 60_000 }); parsed = parseSttJson(r.stdout); } else parsed = await runLocalCli(cfg, eng.name as 'whisper-cpp' | 'whisper-cli', wav, sttLang(cfg, hint.language), hint.prompt ?? cfg.stt.prompt); } catch (e) { return { status: 'failed', cues: [], engine: eng.name, error: (e as Error).message.slice(0, 200) }; }
    if (r.code !== 0) return { status: 'failed', cues: [], engine: eng.name, error: `engine exit ${r.code}` };
    if (!parsed.cues.length) return { status: 'no_speech', cues: [], engine: eng.name, language: parsed.language };
    writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(parsed.cues));
    info('transcribed', { engine: eng.name, cues: parsed.cues.length, language: parsed.language });
    return { status: 'ok', cues: parsed.cues, language: parsed.language, engine: eng.name };
  } catch (e) { warn('stt crashed', { err: (e as Error).message }); return { status: 'failed', cues: [], engine: eng.name, error: (e as Error).message.slice(0, 200) }; }
  finally { clearInterval(beat); release(); if (existsSync(wav)) rmSync(wav, { force: true }); }
}
