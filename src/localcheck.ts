import { totalmem, cpus, arch, platform } from 'node:os';
import type { Config } from './config.ts';
import { detectLocalEngines } from './analysis/localStt.ts';
import { fetchModels } from './ai/autodetect.ts';

/** What this machine can realistically run locally, with no API. Recommendations are rules of thumb (RAM based), not benchmarks. */
export function recommend(ramGb: number, termux: boolean): { whisper: string; whisperNote: string; llm: string; llmNote: string } {
  const whisper = ramGb < 2.5 ? 'tiny' : ramGb < 4 ? 'base' : ramGb < 8 ? 'small' : 'medium';
  const llm = ramGb < 3 ? 'none' : ramGb < 5 ? 'llama3.2:1b' : ramGb < 9 ? 'llama3.2:3b' : ramGb < 17 ? 'qwen2.5:7b' : 'qwen2.5:14b';
  return { whisper, whisperNote: termux ? 'Termux par CPU kam hota hai: whisper.cpp (ggml-' + whisper + '.bin) faster-whisper se halka hai' : `faster-whisper "${whisper}" CPU int8 par theek chalta hai`, llm, llmNote: llm === 'none' ? 'RAM kam: local LLM mat chalao, free API key ya built-in rule engine use karo' : termux ? 'Termux par bada LLM dheema hota hai: VPS/PC par Ollama behtar; phone par chhota model' : `ollama pull ${llm}` };
}
export async function localReport(cfg: Config, fetchFn: typeof fetch = fetch) {
  const ramGb = Math.round((totalmem() / 2 ** 30) * 10) / 10; const termux = /com\.termux/.test(process.env.PREFIX ?? '') || !!process.env.TERMUX_VERSION;
  const engines = await detectLocalEngines(cfg, fetchFn); const ol = await fetchModels('http://127.0.0.1:11434/v1', '', fetchFn);
  return { ramGb, cpuCores: cpus().length, arch: arch(), platform: platform(), termux, recommend: recommend(ramGb, termux), engines: engines.map((e) => ({ id: e.id, available: e.available, detail: e.detail })), ollama: { running: ol.ok, models: ol.models.map((m) => m.id) }, note: 'Built-in rule engine (titles/tags/clip edges) bina kisi model ke hamesha chalta hai.' };
}
