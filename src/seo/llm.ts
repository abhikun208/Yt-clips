import { validateMetadata, type Metadata } from './metadata.ts';
import { composeDescription } from './brief.ts';
import { scoreMetadata } from './score.ts';

export interface LlmEnv { baseUrl: string; apiKey: string; model: string }
/** Optional: any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, Ollama, vLLM...). Disabled unless LLM_BASE_URL and LLM_MODEL are set. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv | null {
  if (!env.LLM_BASE_URL || !env.LLM_MODEL) return null;
  return { baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''), apiKey: env.LLM_API_KEY ?? '', model: env.LLM_MODEL };
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Improve template metadata with an LLM. The model sees only the transcript excerpt + template; its JSON is validated and
 * merged field-by-field. ANY failure (network, bad JSON, invalid fields) returns the template unchanged with a warning.
 */
export async function llmMetadata(base: Metadata, transcript: string, env: LlmEnv, fetchFn: typeof fetch = fetch): Promise<Metadata> {
  try {
    const prompt = `You write YouTube Shorts metadata. Language/style: ${base.language === 'hi' ? 'Hindi (Devanagari)' : 'Hinglish or English matching the transcript'}.\nReturn ONLY JSON: {"title": best title (<=90 chars, hook in the first 40 chars, 1-2 emojis, honest: no claim the transcript does not support), "titles": 3 alternative titles, "about": 1-2 plain sentences (<=200 chars) saying what happens, keyword in the first sentence, "highlights": 3 short bullets (<=12 words each) of real moments, "tags": string[<=12] mixing high-search and niche tags taken from the topic, "searches": 3-5 phrases people would really search for this moment, "thumbnailText": string<=24 chars (the punchiest 3-4 words, curiosity not clickbait)}.\nUse only facts present in the transcript.\nTranscript:\n"""${transcript.slice(0, 3500)}"""\nCurrent draft title: ${base.title}`;
    const res = await fetchFn(`${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.4, messages: [{ role: 'user', content: prompt }] }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '';
    const m = /\{[\s\S]*\}/.exec(content); if (!m) throw new Error('no JSON in reply');
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const title = clip(j.title, 90); if (!title) throw new Error('empty title');
    const tags = Array.isArray(j.tags) ? j.tags.map((t) => clip(t, 40)).filter(Boolean).slice(0, 12) : base.tags;
    const tagline = base.hashtags.join(' ');
    const alts = Array.isArray(j.titles) ? j.titles.map((t) => clip(t, 95)).filter(Boolean).slice(0, 3) : [];
    const out: Metadata = { ...base, titles: [title, ...alts].filter((t, i, a) => a.indexOf(t) === i), title: /#shorts/i.test(title) ? title : `${title} #Shorts`.slice(0, 100), description: (base.parts ? composeDescription({ ...base.parts, about: clip(j.about, 220) || base.parts.about, highlights: Array.isArray(j.highlights) ? j.highlights.map((x) => clip(x, 90)).filter(Boolean).slice(0, 3) : base.parts.highlights, searches: Array.isArray(j.searches) ? j.searches.map((x) => clip(x, 50)).filter(Boolean).slice(0, 5) : base.parts.searches }) : clip(j.description, 4500) || base.description.split('\n\n#')[0]!) + (base.parts || clip(j.description, 4500).includes(tagline) ? '' : `\n\n${tagline}`), tags: tags.length ? tags : base.tags, thumbnailText: clip(j.thumbnailText, 24) || base.thumbnailText, source: 'llm' };
    const errs = validateMetadata(out); if (errs.length) throw new Error(errs.join('; '));
    if (out.seo) out.seo = { ...scoreMetadata(out, { keyphrases: base.keywords, hasChapters: out.seo.chapters >= 3, durationSec: base.parts?.chapters.length ? 30 : 0 }), chapters: out.seo.chapters };
    return out;
  } catch (e) { return { ...base, warnings: [...base.warnings, `llm metadata skipped (${(e as Error).message.slice(0, 80)}); template used`] }; }
}
