import type { Cue } from '../analysis/transcript.ts';
import type { AiCreds } from './settings.ts';
import { toHinglish, hasDevanagari } from './hinglish.ts';
import { guessLanguage } from '../analysis/transcript.ts';

/**
 * Caption translation through the owner's LLM chain (keyless local models work too). Timing is NEVER invented: every output cue keeps
 * the start/end of its source cue; per-word timing is dropped (captions then use approximate word timing, which the manifest reports).
 * Output is accepted only if the model returns exactly one string per input cue; otherwise the next provider is tried, then the
 * original cues are kept. Nothing runs without an LLM configured. Translation quality is the model's, not verified here.
 */
export type Lang = 'en' | 'hi' | 'hinglish';
export type CaptionTarget = Lang | 'auto' | 'original';
const NAME: Record<Lang, string> = { en: 'English', hi: 'Hindi (Devanagari script)', hinglish: 'Hinglish: Hindi written in Roman/Latin letters exactly as Indians type on WhatsApp (e.g. "bhai ye kya ho gaya, clutch mar diya"); never Devanagari, never formal English' };

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

/**
 * Per-channel caption language. 'original' = leave as spoken; 'auto' = Hinglish when the channel is Hindi/Hinglish or the captions came
 * out in Devanagari, else untouched. Hinglish never needs an LLM for Devanagari text (rule-based romanisation is the fallback);
 * English speech → Hinglish needs the LLM chain and is skipped (with a note) when none works.
 */
export async function applyCaptionLanguage(cues: Cue[], target: CaptionTarget, channelLang: string | undefined, chain: AiCreds[], fetchFn: typeof fetch = fetch): Promise<{ cues: Cue[]; used: string | null; note?: string }> {
  if (!cues.length || target === 'original') return { cues, used: null };
  const text = cues.map((c) => c.text).join(' ');
  const hindiChannel = channelLang === 'hi' || channelLang === 'hinglish';
  const to: Lang | null = target === 'auto' ? (hindiChannel || hasDevanagari(text) ? 'hinglish' : null) : target;
  if (!to) return { cues, used: null };
  if (to === 'hinglish') {
    const g = hasDevanagari(text) ? 'hi' : guessLanguage(text);
    if (g === 'hinglish') return { cues, used: null };
    if (hasDevanagari(text) && !chain.length) return { cues: cues.map((c) => ({ start: c.start, end: c.end, text: toHinglish(c.text) })), used: 'rule-based romanisation' };
    if (g === 'en' && !hindiChannel && target === 'auto') return { cues, used: null };
    const r = await translateCues(cues, 'hinglish', chain, fetchFn);
    if (r.used) return r;
    if (hasDevanagari(text)) return { cues: cues.map((c) => ({ start: c.start, end: c.end, text: toHinglish(c.text) })), used: 'rule-based romanisation', note: r.note };
    return r;
  }
  if (to === 'hi' && !hasDevanagari(text) && guessLanguage(text) === 'hi') return { cues, used: null };
  return translateCues(cues, to, chain, fetchFn);
}
