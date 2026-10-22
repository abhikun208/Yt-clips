import { validateMetadata, type Metadata } from './metadata.ts';

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
    const prompt = `You write YouTube Shorts metadata. Language/style: ${base.language === 'hi' ? 'Hindi (Devanagari)' : 'Hinglish or English matching the transcript'}.\nReturn ONLY JSON: {"title": string<=90 chars, no clickbait lies, "description": string, "tags": string[<=12], "thumbnailText": string<=24 chars}.\nDo not invent facts not present in the transcript.\nTranscript:\n"""${transcript.slice(0, 3500)}"""\nCurrent draft title: ${base.title}`;
    const res = await fetchFn(`${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.4, messages: [{ role: 'user', content: prompt }] }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '';
    const m = /\{[\s\S]*\}/.exec(content); if (!m) throw new Error('no JSON in reply');
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const title = clip(j.title, 90); if (!title) throw new Error('empty title');
    const tags = Array.isArray(j.tags) ? j.tags.map((t) => clip(t, 40)).filter(Boolean).slice(0, 12) : base.tags;
    const tagline = base.hashtags.join(' ');
    const out: Metadata = { ...base, title: /#shorts/i.test(title) ? title : `${title} #Shorts`.slice(0, 100), description: (clip(j.description, 4500) || base.description.split('\n\n#')[0]!) + (clip(j.description, 4500).includes(tagline) ? '' : `\n\n${tagline}`), tags: tags.length ? tags : base.tags, thumbnailText: clip(j.thumbnailText, 24) || base.thumbnailText, source: 'llm' };
    const errs = validateMetadata(out); if (errs.length) throw new Error(errs.join('; '));
    return out;
  } catch (e) { return { ...base, warnings: [...base.warnings, `llm metadata skipped (${(e as Error).message.slice(0, 80)}); template used`] }; }
}
