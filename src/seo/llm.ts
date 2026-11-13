import { validateMetadata, type Metadata } from './metadata.ts';
import { llmFetch } from '../ai/health.ts';
import { composeDescription } from './brief.ts';
import { scoreMetadata } from './score.ts';

export interface LlmEnv { baseUrl: string; apiKey: string; model: string }
/** Optional: any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, Ollama, vLLM...). Disabled unless LLM_BASE_URL and LLM_MODEL are set. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv | null {
  if (!env.LLM_BASE_URL || !env.LLM_MODEL) return null;
  return { baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''), apiKey: env.LLM_API_KEY ?? '', model: env.LLM_MODEL };
}

const HI = /\b(hai|hain|ka|ki|ke|ko|se|mein|me|ye|yeh|woh|wo|aur|nahi|nahin|kya|kaise|bhai|hum|tum|aap|ho|tha|thi|raha|rahi|kar|kiya|gaya|gayi|liye|wala|wali|bahut|jab|tab|abhi|sab|kuch|toh|bhi|dekh\w*|aakhir|pade|karte|karta|karti|hota|hoti|hua|hue|apne|apna|uska|iska|jo|par|pe|sirf|bas)\b/gi;
const EN = /\b(the|is|and|of|to|in|this|that|with|for|are|was|he|she|they|his|her|their|on|at|by|from|an|a)\b/gi;
/** True for a sentence that is English (no Hinglish marker word, several English function words). Short fragments are not judged. */
export const looksEnglish = (t: string): boolean => { if (/[\u0900-\u097F]/.test(t)) return false; const w = t.trim().split(/\s+/).length; if (w < 5) return false; const hi = (t.match(HI) ?? []).length; const en = (t.match(EN) ?? []).length; return hi === 0 && en >= 2; };
/** Ask the model once to rewrite lines in Roman Hinglish; null on any failure. */
async function toHinglishLlm(env: LlmEnv, fetchFn: typeof fetch, lines: string[]): Promise<string[] | null> {
  try {
    const res = await llmFetch(fetchFn, env, `${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(45_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.3, messages: [{ role: 'user', content: `Rewrite each line in Roman Hinglish (Hindi written in English letters, like "Is clip mein bhai ne kamaal kar diya"), same meaning, same count. Never Devanagari. Return ONLY a JSON array of ${lines.length} strings.\n${JSON.stringify(lines)}` }] }) });
    if (!res.ok) return null; const rj = (await res.json()) as { choices?: { message?: { content?: string } }[] }; const m = /\[[\s\S]*\]/.exec(rj.choices?.[0]?.message?.content ?? ''); if (!m) return null;
    const a = JSON.parse(m[0]) as unknown; return Array.isArray(a) && a.length === lines.length && a.every((x) => typeof x === 'string' && x.trim()) ? (a as string[]).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 220)) : null;
  } catch { return null; }
}
const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Improve template metadata with an LLM. The model sees only the transcript excerpt + template; its JSON is validated and
 * merged field-by-field. ANY failure (network, bad JSON, invalid fields) returns the template unchanged with a warning.
 */
export async function llmMetadata(base: Metadata, transcript: string, env: LlmEnv, fetchFn: typeof fetch = fetch, trends: string[] = [], examples: string[] = [], insight: string | null = null, visual: string | null = null): Promise<Metadata> {
  try {
    const prompt = `You write YouTube Shorts metadata. Language/style: ${base.language === 'en' ? 'natural English' : 'Roman Hinglish: Hindi/Urdu words typed in English letters (e.g. "Ye kya kar diya!"), English words allowed; NEVER Devanagari or Urdu script, and never an English translation of the dialogue'}. ${base.language === 'en' ? '' : ' "about" and EVERY "highlights" bullet must also be Roman Hinglish (example about: "Is clip mein bhai ne aisa kaam kiya ki sab hans pade, aakhir mein kya hua dekhiye."); an English sentence there is wrong.'} Never write filler like 'is mentioned in this clip' or 'the speaker talks about'.\nReturn ONLY JSON: {"title": best title (<=60 chars so phones do not cut it, the most specific name/number/moment from the transcript in the first 30 chars, a curiosity gap or a reaction, 1-2 emojis, honest: no claim the transcript does not support, no generic words like 'amazing moments'), "titles": 3 alternative titles, each with a DIFFERENT angle (a question / a bold claim the video proves / the viewer's emotional reaction), same 60-char limit, "about": 1-2 plain sentences (<=200 chars) saying what happens, keyword in the first sentence, "highlights": 10 short bullets (<=12 words each) of real moments in this clip, "tags": 30 strings mixing high-search and niche tags taken from the topic (never filler like video/viral/short), "hashtags": 20 relevant hashtags without the # sign (single words or CamelCase phrases about THIS video; never filler words like bhai, gaya, sabko), "broll": 4 ENGLISH stock-footage search terms (2-3 words, e.g. "rainy street", "cooking pasta") that visually match THIS video, "searches": 8 phrases people would really search for this moment, "thumbnailText": string<=24 chars (the punchiest 3-4 words, curiosity not clickbait)}.\nUse only facts present in the transcript, the visible frames and the source video title.${base.sourceTitle ? `\nSource video title (real names/topic live here; the speech-to-text often mis-hears names and English words, so trust this title for spellings): "${base.sourceTitle.slice(0, 160)}"` : ''}${trends.length ? `\nTrending in India right now AND spoken in this video: ${trends.join(' | ')}. You may use AT MOST ONE of these in the title or searches, only if it truly fits what happens; never imply anything the transcript does not show.` : ''}${examples.length ? `\nThis channel's own best-performing past titles (measured by views): ${examples.map((t) => `"${t.slice(0, 90)}"`).join(' | ')}. Use them ONLY as a style reference (length, structure, emotion); never copy their words or claims - write about THIS transcript.${insight ? ` What they share: ${insight}` : ''} Use these as a hint, not a template: make exactly one of the 3 alternatives deliberately DIFFERENT from this pattern (new angle), so new styles get tested.` : ''}${visual ? `\nWhat is visible on screen (from the frames): ${visual}` : ''}\nTranscript:\n"""${transcript.slice(0, 3500)}"""\nCurrent draft title: ${base.title}`;
    const res = await llmFetch(fetchFn, env, `${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.4, messages: [{ role: 'user', content: prompt }] }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rj = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string; reasoning?: string } }[] }; const ch0 = rj.choices?.[0];
    const content = ch0?.message?.content || ch0?.message?.reasoning || '';
    const m = /\{[\s\S]*\}/.exec(content); if (!m) throw new Error(`no JSON in reply (finish=${ch0?.finish_reason ?? '?'}, ${content.length} chars: ${content.slice(0, 60).replace(/\s+/g, ' ')})`);
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const title = clip(j.title, 90); if (!title) throw new Error('empty title');
    const arr = (v: unknown, n: number, len: number): string[] => Array.isArray(v) ? v.map((t) => clip(t, len)).filter(Boolean).slice(0, n) : [];
    const tags = arr(j.tags, 30, 40); const aiHashtags = arr(j.hashtags, 25, 32).map((h) => h.replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean).map((h) => '#' + h);
    const alts = Array.isArray(j.titles) ? j.titles.map((t) => clip(t, 95)).filter(Boolean).slice(0, 3) : [];
    let about = clip(j.about, 220); let highlights = arr(j.highlights, 10, 90); const searches = arr(j.searches, 8, 50); const warn: string[] = [];
    if (base.language !== 'en' && (looksEnglish(about) || highlights.some(looksEnglish))) { // the owner's rule: description in Roman Hinglish, never an English translation
      const fixed = await toHinglishLlm(env, fetchFn, [about, ...highlights]);
      if (fixed && !looksEnglish(fixed[0]!) && !fixed.slice(1).some(looksEnglish)) { about = fixed[0]!; highlights = fixed.slice(1); warn.push('description rewritten from English to Roman Hinglish'); }
      else { about = base.parts?.about ?? ''; highlights = base.parts?.highlights ?? []; warn.push('AI wrote English description: template Hinglish text used'); }
    }
    const parts = base.parts ? { ...base.parts, about: about || base.parts.about, highlights: highlights.length ? highlights : base.parts.highlights, searches: searches.length ? searches : base.parts.searches, hashtags: aiHashtags.length >= 5 ? ['#Shorts', ...aiHashtags] : base.parts.hashtags } : undefined; // 5+ AI hashtags = the AI's view of THIS video replaces the transcript-word template (mis-heard words like #Neeche #Bahal)
    const out: Metadata = { ...base, titles: [title, ...alts].filter((t, i, a) => a.indexOf(t) === i), title: /#shorts/i.test(title) ? title : `${title} #Shorts`.slice(0, 100), description: parts ? composeDescription(parts) : (clip(j.description, 4500) || base.description.split('\n\n#')[0]!) + (clip(j.description, 4500).includes(base.hashtags.join(' ')) ? '' : `\n\n${base.hashtags.join(' ')}`), parts, tags: tags.length ? tags : base.tags, hashtags: aiHashtags.length >= 5 ? [...new Set(['#Shorts', ...aiHashtags])] : aiHashtags.length ? [...new Set([...base.hashtags, ...aiHashtags])].slice(0, 25) : base.hashtags, thumbnailText: clip(j.thumbnailText, 24) || base.thumbnailText, source: 'llm', broll: arr(j.broll, 4, 40), warnings: [...base.warnings, ...warn] };
    const errs = validateMetadata(out); if (errs.length) throw new Error(errs.join('; '));
    if (out.seo) out.seo = { ...scoreMetadata(out, { keyphrases: base.keywords, hasChapters: out.seo.chapters >= 3, durationSec: base.parts?.chapters.length ? 30 : 0 }), chapters: out.seo.chapters };
    return out;
  } catch (e) { return { ...base, warnings: [...base.warnings, `llm metadata skipped (${(e as Error).message.slice(0, 80)}); template used`] }; }
}
