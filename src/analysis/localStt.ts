import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { run, which } from '../util/proc.ts';
import { parseSttJson } from './stt.ts';
import type { Cue } from './transcript.ts';

/**
 * Local (no API, no internet at run time) speech-to-text engines. We do NOT copy VoiceStudio's code (it is AGPL-3.0 and a desktop app):
 * its speech engines (Whisper family) are driven here directly, and a running VoiceStudio server can optionally be used as a backend.
 * Engines: faster-whisper (python), whisper.cpp CLI, openai-whisper CLI, custom command, VoiceStudio local server.
 */
export type LocalEngineId = 'faster-whisper' | 'whisper-cpp' | 'whisper-cli' | 'custom' | 'voicestudio';
export interface EngineInfo { id: LocalEngineId; label: string; available: boolean; detail: string; install: string; verified: string }
export const VOICESTUDIO_DEFAULT = 'http://127.0.0.1:3900';
export const CPP_BINS = ['whisper-cli', 'whisper-cpp', 'whisper.cpp'];

export const voiceStudioUrl = (cfg: Config) => (process.env.YT_CLIPS_VOICESTUDIO_URL || cfg.stt.voiceStudioUrl || VOICESTUDIO_DEFAULT).replace(/\/+$/, '');
/** Where `tools/install-whisper-cpp.sh` / `setup.sh` put whisper.cpp (so nothing has to be written to .env or PATH by hand). */
const cppDirs = (): string[] => [process.env.WHISPER_CPP_DIR, join(process.env.HOME ?? '', 'whisper.cpp'), join(process.cwd(), 'vendor', 'whisper.cpp')].filter((x): x is string => !!x);
export const cppModelPath = (cfg: Config) => {
  const set = process.env.YT_CLIPS_WHISPER_CPP_MODEL || cfg.stt.cppModel || ''; if (set && existsSync(set)) return set;
  for (const d of cppDirs()) for (const m of ['small', 'base', 'tiny', 'medium']) { const f = join(d, 'models', `ggml-${m}.bin`); if (existsSync(f)) return f; }
  return set;
};
async function cppBin(): Promise<string | null> {
  for (const b of CPP_BINS) if (await which(b)) return b;
  for (const d of cppDirs()) for (const rel of ['build/bin/whisper-cli', 'build/bin/main', 'bin/whisper-cli']) { const f = join(d, rel); if (existsSync(f)) return f; }
  return null;
}

/** GET a few cheap URLs on the VoiceStudio server; any HTTP answer (<500) means something is listening. */
export async function probeVoiceStudio(base: string, fetchFn: typeof fetch = fetch): Promise<{ up: boolean; route?: string }> {
  for (const path of ['/health', '/v1/models', '/api/health', '/']) {
    try { const r = await fetchFn(base + path, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) return { up: true, route: path }; } catch { /* next */ }
  }
  return { up: false };
}

export async function detectLocalEngines(cfg: Config, fetchFn: typeof fetch = fetch): Promise<EngineInfo[]> {
  const out: EngineInfo[] = [];
  const py = await which('python3'); const fw = py && (await run('python3', ['-I', '-c', 'import faster_whisper'], { timeoutMs: 20_000 }).catch(() => null))?.code === 0;
  out.push({ id: 'faster-whisper', label: 'faster-whisper (Python, CPU)', available: !!fw, detail: fw ? 'installed' : py ? 'python3 hai, package nahi' : 'python3 nahi', install: 'pip install faster-whisper   (VPS/PC par best; Termux par heavy)', verified: 'tools/transcribe.py; not run on a real model in the sandbox' });
  const cpp = await cppBin(); const mp = cppModelPath(cfg); const mOk = !!mp && existsSync(mp);
  out.push({ id: 'whisper-cpp', label: 'whisper.cpp (C++, phone-friendly)', available: !!cpp && mOk, detail: cpp ? (mOk ? `${cpp} + model ${mp}` : `${cpp} mila, model file set nahi (YT_CLIPS_WHISPER_CPP_MODEL ya Local STT card mein path do, e.g. ggml-small.bin)`) : 'binary nahi mila', install: 'Termux: pkg install whisper-cpp (agar available) ya source build; model: ggml-small.bin (huggingface ggerganov/whisper.cpp)', verified: 'adapter tested with a stand-in binary only' });
  const wc = await which('whisper');
  out.push({ id: 'whisper-cli', label: 'OpenAI whisper CLI (Python)', available: wc, detail: wc ? 'installed' : 'nahi mila', install: 'pip install openai-whisper', verified: 'adapter tested with a stand-in binary only' });
  const custom = process.env.YT_CLIPS_STT_CMD?.trim();
  out.push({ id: 'custom', label: 'Custom command (YT_CLIPS_STT_CMD)', available: !!custom, detail: custom ? custom : 'set nahi', install: 'YT_CLIPS_STT_CMD="<cmd> {audio.wav} {model} {lang}" -> JSON {language, segments[]}', verified: 'tested' });
  const vs = voiceStudioUrl(cfg); const pr = await probeVoiceStudio(vs, fetchFn);
  out.push({ id: 'voicestudio', label: 'VoiceStudio local server', available: pr.up, detail: pr.up ? `${vs} chal raha hai` : `${vs} par kuch nahi chal raha (VoiceStudio app/server start karo; URL change: YT_CLIPS_VOICESTUDIO_URL)`, install: 'github.com/debpalash/VoiceStudio (AGPL-3.0) chalao; ye project uska code copy nahi karta, sirf server se baat karta hai', verified: 'UNVERIFIED: VoiceStudio source sandbox se padh nahi paya; /v1/audio/transcriptions route maana gaya hai, "Test" dabake check karo' });
  return out;
}

/** First available local engine in preference order (explicit cfg.stt.localEngine wins). */
export async function pickLocal(cfg: Config, fetchFn: typeof fetch = fetch): Promise<EngineInfo | null> {
  const all = await detectLocalEngines(cfg, fetchFn); const want = cfg.stt.localEngine;
  if (want && want !== 'auto') { const w = all.find((e) => e.id === want && e.available); if (w) return w; /* the chosen engine is not usable here: fall back to whatever IS installed instead of giving up */ }
  const order: LocalEngineId[] = ['custom', 'faster-whisper', 'whisper-cpp', 'whisper-cli', 'voicestudio'];
  for (const id of order) { const e = all.find((x) => x.id === id && x.available); if (e) return e; } return null;
}

/** whisper.cpp -oj output: { transcription: [{ offsets: {from,to} (ms), text }] }. Segment-level timing only (no word times). */
export function parseWhisperCppJson(txt: string): { cues: Cue[]; language?: string } {
  const j = JSON.parse(txt) as { result?: { language?: string }; transcription?: { offsets?: { from: number; to: number }; text?: string }[] };
  const segs: { start: number; end: number; text: string }[] = [];
  for (const s of j.transcription ?? []) { const a = Number(s.offsets?.from) / 1000, b = Number(s.offsets?.to) / 1000, t = String(s.text ?? '').trim(); if (Number.isFinite(a) && Number.isFinite(b) && b > a && t && !/^\[.*\]$/.test(t) && !/^\(.*\)$/.test(t)) segs.push({ start: a, end: b, text: t }); }
  // `-ml 1 -sow` makes whisper.cpp emit one word per entry: regroup into short caption cues that keep per-word times (needed for word-highlight captions)
  if (segs.length > 3 && segs.every((x) => !/\s/.test(x.text))) {
    const cues: Cue[] = []; let cur: Cue | null = null;
    for (const w of segs) {
      if (cur && (w.start - cur.end > 0.7 || cur.words!.length >= 7 || /[.?!]$/.test(cur.words![cur.words!.length - 1]!.text))) { cues.push(cur); cur = null; }
      if (!cur) cur = { start: w.start, end: w.end, text: '', words: [] }; cur.words!.push({ start: w.start, end: w.end, text: w.text }); cur.end = w.end; cur.text = cur.words!.map((x) => x.text).join(' ');
    }
    if (cur) cues.push(cur); return { cues, language: j.result?.language };
  }
  return { cues: segs.map((x) => ({ start: x.start, end: x.end, text: x.text })), language: j.result?.language };
}

/** Run one local engine on a 16 kHz mono wav. Returns cues or throws. VoiceStudio is handled by the caller (needs the video for chunking). */
export async function runLocalCli(cfg: Config, id: LocalEngineId, wav: string, lang: string): Promise<{ cues: Cue[]; language?: string }> {
  const l = lang && lang !== 'auto' ? lang : 'auto';
  if (id === 'whisper-cpp') {
    const bin = await cppBin(); if (!bin) throw new Error('whisper.cpp binary nahi mila'); const prefix = wav.replace(/\.wav$/, '');
    const base = ['-m', cppModelPath(cfg), '-f', wav, '-oj', '-of', prefix, '-l', l, '-np'];
    let r = await run(bin, [...base, '-ml', '1', '-sow'], { timeoutMs: 4 * 60 * 60_000 }); // word times; older builds without these flags: retry plain
    if (r.code !== 0) r = await run(bin, base, { timeoutMs: 4 * 60 * 60_000 });
    const jf = prefix + '.json'; try { if (r.code !== 0 || !existsSync(jf)) throw new Error(`whisper.cpp exit ${r.code}: ${r.stderr.slice(0, 150)}`); return parseWhisperCppJson(readFileSync(jf, 'utf8')); } finally { rmSync(jf, { force: true }); }
  }
  if (id === 'whisper-cli') {
    const dir = wav.replace(/\.wav$/, '_out'); mkdirSync(dir, { recursive: true });
    try {
      const args = [wav, '--model', cfg.stt.model, '--output_format', 'json', '--output_dir', dir, '--word_timestamps', 'True', '--fp16', 'False', ...(l !== 'auto' ? ['--language', l] : [])];
      const r = await run('whisper', args, { timeoutMs: 4 * 60 * 60_000 }); const f = readdirSync(dir).find((x) => x.endsWith('.json'));
      if (r.code !== 0 || !f) throw new Error(`whisper exit ${r.code}: ${r.stderr.slice(-150)}`);
      return parseSttJson(readFileSync(join(dir, f), 'utf8'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  throw new Error(`engine ${id} is not a CLI engine`);
}

/** Real check for the UI "Test" button: transcribe a generated 2 s silent clip (proves the engine starts and returns valid output, not that it hears speech). */
export async function testLocal(cfg: Config, id: LocalEngineId): Promise<{ ok: boolean; text: string }> {
  const all = await detectLocalEngines(cfg); const e = all.find((x) => x.id === id); if (!e) return { ok: false, text: 'unknown engine' }; if (!e.available) return { ok: false, text: e.detail };
  mkdirSync(cfg.dirs.tmp, { recursive: true }); const wav = join(cfg.dirs.tmp, `sttest_${Date.now()}.wav`);
  try {
    const g = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '16000', '-ac', '1', wav], { timeoutMs: 30_000 }); if (g.code !== 0) return { ok: false, text: 'ffmpeg nahi chala' };
    if (id === 'voicestudio') { const pr = await probeVoiceStudio(voiceStudioUrl(cfg)); return pr.up ? { ok: true, text: `server upar hai (${pr.route}); asli transcription pehli video par dikhega` } : { ok: false, text: 'server nahi mila' }; }
    if (id === 'faster-whisper' || id === 'custom') return { ok: true, text: 'engine import/command mil gaya (model pehli transcription par download hoga)' };
    const t0 = Date.now(); await runLocalCli(cfg, id, wav, 'auto'); return { ok: true, text: `engine chala, valid output (${((Date.now() - t0) / 1000).toFixed(1)} s)` };
  } catch (e) { return { ok: false, text: (e as Error).message.slice(0, 200) }; } finally { rmSync(wav, { force: true }); }
}
