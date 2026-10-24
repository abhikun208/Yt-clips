import type { Cue } from '../analysis/transcript.ts';
import type { AiCreds } from './settings.ts';

/**
 * Caption translation through the owner's LLM chain (keyless local models work too). Timing is NEVER invented: every output cue keeps
 * the start/end of its source cue; per-word timing is dropped (captions then use approximate word timing, which the manifest reports).
 * Output is accepted only if the model returns exactly one string per input cue; otherwise the next provider is tried, then the
 * original cues are kept. Nothing runs without an LLM configured. Translation quality is the model's, not verified here.
 */
export type Lang = 'en' | 'hi';
const NAME: Record<Lang, string> = { en: 'English', hi: 'Hindi (Devanagari script)' };

export async function translateCues(cues: Cue[], to: Lang, chain: AiCreds[], fetchFn: typeof fetch = fetch): Promise<{ cues: Cue[]; used: string | null; note?: string }> {
  if (!cues.length || !chain.length) return { cues, used: null, note: chain.length ? undefined : 'no LLM configured: captions not translated' };
  const out: Cue[] = []; let used: string | null = null; let note: string | undefined;
  for (let i = 0; i < cues.length; i += 40) {
    const batch = cues.slice(i, i + 40); let done: string[] | null = null;
    for (const env of chain) {
      try {
        const res = await fetchFn(`${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(90_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.2, messages: [
          { role: 'system', content: `You translate subtitle lines into ${NAME[to]}. Keep each line short, natural and spoken-style; keep gaming terms (booyah, headshot, clutch, zone, squad) and names as they are. Return ONLY JSON: {"lines":["..."]} with EXACTLY ${batch.length} strings, same order.` },
          { role: 'user', content: JSON.stringify(batch.map((c) => c.text)) }] }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '';
        const m = /\{[\s\S]*\}/.exec(content); if (!m) throw new Error('no JSON');
        const lines = (JSON.parse(m[0]) as { lines?: unknown }).lines;
        if (!Array.isArray(lines) || lines.length !== batch.length || lines.some((l) => typeof l !== 'string' || !l.trim() || l.length > 300)) throw new Error('bad line count/content');
        done = lines as string[]; used = `${env.model}`; break;
      } catch (e) { note = `translation provider failed: ${(e as Error).message.slice(0, 60)}`; }
    }
    if (!done) return { cues, used: null, note: note ?? 'translation failed; original captions kept' };
    batch.forEach((c, k) => out.push({ start: c.start, end: c.end, text: done![k]!.trim() }));
  }
  return { cues: out, used };
}
