import type { Cue } from '../analysis/transcript.ts';
import type { AiCreds } from './settings.ts';

/**
 * Contextual caption clean-up by the owner's LLM chain (free Groq/Gemini/OpenRouter or a local Ollama). The model only sees the caption lines, the
 * source video's title and the channel vocabulary, and is told to fix spelling / proper nouns (brand and person names) and nothing else.
 * Safety net - a line is accepted ONLY if it has exactly the same number of words and every word is close to the original (edit distance
 * <= 50 %): so meaning, line count and per-word timing can never be changed by a model that rewrites or hallucinates. Never throws.
 */
export const lev = (a: string, b: string): number => { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]!; };
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function acceptLine(orig: string, fixed: string): boolean {
  const a = orig.split(/\s+/).filter(Boolean), b = fixed.split(/\s+/).filter(Boolean); if (!a.length || a.length !== b.length) return false;
  return a.every((w, i) => { const x = norm(w), y = norm(b[i]!); if (x === y) return true; if (!x || !y) return false; return lev(x, y) / Math.max(x.length, y.length) <= 0.5; });
}
export async function llmFixCaptions(cues: Cue[], ctx: { title?: string; vocabulary?: string[]; lang?: string }, chain: AiCreds[], fetchFn: typeof fetch = fetch): Promise<{ cues: Cue[]; changed: number; used: string | null; note?: string }> {
  if (!cues.length || !chain.length) return { cues, changed: 0, used: null };
  const out = cues.map((c) => ({ ...c })); let changed = 0, used: string | null = null, note: string | undefined;
  const hint = [ctx.title ? `Video title: "${ctx.title.slice(0, 120)}".` : '', ctx.vocabulary?.length ? `Known names/words: ${ctx.vocabulary.slice(0, 40).join(', ')}.` : ''].filter(Boolean).join(' ');
  for (let i = 0; i < cues.length; i += 40) {
    const batch = cues.slice(i, i + 40); let lines: string[] | null = null;
    for (const env of chain) {
      try {
        const res = await fetchFn(`${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(25_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0, messages: [
          { role: 'system', content: `You correct speech-recognition mistakes in Hindi/Hinglish/English subtitle lines. ${hint} Fix ONLY wrong spellings and misheard proper nouns (brands, people, places). Do not rephrase, translate, add or remove words: every line must keep EXACTLY the same number of words, in the same script (Roman stays Roman). Return ONLY JSON {"lines":[...]} with ${batch.length} strings, same order.` },
          { role: 'user', content: JSON.stringify(batch.map((c) => c.text)) }] }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''; const m = /\{[\s\S]*\}/.exec(content); if (!m) throw new Error('no JSON');
        const l = (JSON.parse(m[0]) as { lines?: unknown }).lines; if (!Array.isArray(l) || l.length !== batch.length || l.some((x) => typeof x !== 'string')) throw new Error('bad line count');
        lines = l as string[]; used = env.model; break;
      } catch (e) { note = `caption fix provider failed: ${(e as Error).message.slice(0, 60)}`; }
    }
    if (!lines) continue;
    lines.forEach((fx, k) => {
      const c = batch[k]!, idx = i + k; if (fx.trim() === c.text.trim() || !acceptLine(c.text, fx)) return;
      const nw = fx.split(/\s+/).filter(Boolean); out[idx] = { ...c, text: nw.join(' '), ...(c.words && c.words.length === nw.length ? { words: c.words.map((w, j) => ({ ...w, text: nw[j]! })) } : {}) }; changed++;
    });
  }
  return { cues: out, changed, used, ...(note && !used ? { note } : {}) };
}
