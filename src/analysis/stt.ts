import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Cue } from './transcript.ts';
import { run, which } from '../util/proc.ts';
import { warn, info } from '../util/log.ts';
import { sttCreds } from '../ai/settings.ts';
import { transcribeViaApi } from './sttApi.ts';
import { transcribeViaGemini } from './geminiStt.ts';
import { llmChain } from '../ai/settings.ts';
import { pickLocal, runLocalCli, voiceStudioUrl } from './localStt.ts';

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
interface RawSeg { start: number; end: number; text: string; words?: { start: number; end: number; word?: string; text?: string }[] }
/** Validate + normalise engine output. Drops malformed segments/words; never invents timing. */
export function parseSttJson(stdout: string): { cues: Cue[]; language?: string } {
  const j = parseLooseJson(stdout) as { error?: string; language?: string; segments?: RawSeg[] };
  if (j.error) throw new Error(j.error);
  const cues: Cue[] = [];
  for (const s of j.segments ?? []) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start || !String(s.text ?? '').trim()) continue;
    const words = (s.words ?? []).map((w) => ({ start: w.start, end: w.end, text: String(w.word ?? w.text ?? '').trim() })).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.text);
    cues.push({ start: s.start, end: s.end, text: String(s.text).trim(), ...(words.length ? { words } : {}) });
  }
  cues.sort((a, b) => a.start - b.start);
  return { cues, language: j.language };
}

/** Extract 16k mono audio, run STT, write the `<video>.json` sidecar the analyzer/captions already read. Never throws: failure => status. */
export async function transcribeVideo(cfg: Config, videoPath: string, hint: { language?: string; prompt?: string } = {}): Promise<SttResult> {
  if (!process.env.YT_CLIPS_STT_CMD && cfg.stt.engine !== 'local') {
    const api = sttCreds(cfg);
    if (api) {
      try {
        const r = await transcribeViaApi(videoPath, cfg.dirs.tmp, api, { language: hint.language ?? cfg.stt.language, prompt: hint.prompt ?? cfg.stt.prompt });
        if (!r.cues.length) return { status: 'no_speech', cues: [], engine: 'api', language: r.language };
        writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(r.cues)); info('transcribed', { engine: 'api', model: api.model, cues: r.cues.length, language: r.language });
        return { status: 'ok', cues: r.cues, language: r.language, engine: 'api' };
      } catch (e) { warn('api stt failed', { err: (e as Error).message.slice(0, 160) }); return { status: 'failed', cues: [], engine: 'api', error: (e as Error).message.slice(0, 200) }; }
    }
  }
  if (cfg.stt.engine === 'api') return { status: 'unavailable', cues: [], error: 'stt.engine=api but no API key saved' };
  const pick = await pickLocal(cfg);
  if (pick?.id === 'voicestudio') {
    try {
      const r = await transcribeViaApi(videoPath, cfg.dirs.tmp, { baseUrl: voiceStudioUrl(cfg) + '/v1', apiKey: '', model: cfg.stt.model }, { language: hint.language ?? cfg.stt.language, prompt: hint.prompt ?? cfg.stt.prompt });
      if (!r.cues.length) return { status: 'no_speech', cues: [], engine: 'voicestudio', language: r.language };
      writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(r.cues)); info('transcribed', { engine: 'voicestudio', cues: r.cues.length });
      return { status: 'ok', cues: r.cues, language: r.language, engine: 'voicestudio' };
    } catch (e) { return { status: 'failed', cues: [], engine: 'voicestudio', error: (e as Error).message.slice(0, 200) }; }
  }
  const eng = pick && (pick.id === 'faster-whisper' || pick.id === 'custom') ? await sttEngine(cfg.rootDir) : pick ? { cmd: '', args: [], name: pick.id } : null;
  if (!eng && cfg.stt.engine !== 'local') { // last resort: a saved Gemini key can listen to audio (approximate timing, labelled engine "gemini-audio")
    const g = llmChain(cfg).find((x) => /generativelanguage\.googleapis\.com/.test(x.baseUrl));
    if (g) { try { const r = await transcribeViaGemini(videoPath, cfg.dirs.tmp, g, { language: hint.language ?? cfg.stt.language }); if (!r.cues.length) return { status: 'no_speech', cues: [], engine: 'gemini-audio' }; writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(r.cues)); info('transcribed', { engine: 'gemini-audio', cues: r.cues.length }); return { status: 'ok', cues: r.cues, engine: 'gemini-audio' }; } catch (e) { return { status: 'failed', cues: [], engine: 'gemini-audio', error: (e as Error).message.slice(0, 200) }; } }
  }
  if (!eng) return { status: 'unavailable', cues: [], error: 'no local STT engine (Setup -> Local speech-to-text shows what to install; or add a free Groq key)' };
  const wav = join(cfg.dirs.tmp, `stt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    const ex = await run('ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeoutMs: 30 * 60_000 });
    if (ex.code !== 0) return { status: 'failed', cues: [], engine: eng.name, error: `audio extraction failed: ${ex.stderr.slice(0, 150)}` };
    let r = { code: 0, stdout: '', stderr: '' }; let parsed: { cues: Cue[]; language?: string };
    try { if (eng.cmd) { r = await run(eng.cmd, [...eng.args, wav, cfg.stt.model, hint.language ?? cfg.stt.language], { timeoutMs: 4 * 60 * 60_000 }); parsed = parseSttJson(r.stdout); } else parsed = await runLocalCli(cfg, eng.name as 'whisper-cpp' | 'whisper-cli', wav, hint.language ?? cfg.stt.language); } catch (e) { return { status: 'failed', cues: [], engine: eng.name, error: (e as Error).message.slice(0, 200) }; }
    if (r.code !== 0) return { status: 'failed', cues: [], engine: eng.name, error: `engine exit ${r.code}` };
    if (!parsed.cues.length) return { status: 'no_speech', cues: [], engine: eng.name, language: parsed.language };
    writeFileSync(videoPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(parsed.cues));
    info('transcribed', { engine: eng.name, cues: parsed.cues.length, language: parsed.language });
    return { status: 'ok', cues: parsed.cues, language: parsed.language, engine: eng.name };
  } catch (e) { warn('stt crashed', { err: (e as Error).message }); return { status: 'failed', cues: [], engine: eng.name, error: (e as Error).message.slice(0, 200) }; }
  finally { if (existsSync(wav)) rmSync(wav, { force: true }); }
}
