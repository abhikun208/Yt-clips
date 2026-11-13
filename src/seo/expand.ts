import type { Store } from '../db.ts';
import { suggestKeywords, relevantSuggestions } from './suggest.ts';

/** Filler a (often mis-heard) Hinglish transcript is full of: never a tag, keyword or hashtag. */
const JUNK = new Set(('gaya gayi gaye gayee sabko sabse sabhi sab bhai bhaiya yaar yar arre are arey abhi bhi bas bahut bohot kuch kuchh koi kaun kaise kyun kyu kyon kya kab kahan yahan wahan idhar udhar jaise jaisa waise waisa isliye isko usko unko unka unki unke inka inki inke mujhe mujhko tumhe tumko humko hamara hamari aapka aapki aapko aapke apna apni apne hota hoti hote hoga hogi honge karna karne karke karta karti karte kiya kiye kare karen karo kijiye dekho dekh dekhna chalo chal chalo liye wala wali wale vala vali vale lekin magar phir fir jabki jab tab tabhi toh tho thi thaa raha rahi rahe rahega hain hoon hun hum tum aap woh yeh wo ye vo mera meri mere tera teri tere uska uski uske iska iski iske sirf bilkul ekdum lagta lagti lagte mat nahi nahin naa haan han ji accha achha theek thik sahi kar do de dena diya diye liya lena le lo bol bolo bola boli bolna kahna kaha kehna keh kuchh aisa aisi aise waha yaha unnis bees tees chalis pachas ek teen paanch chhe saat aath nau das gyarah barah the and the for you your that this with have what was are not but can will just like get got out all one its then them they their there here how why who when from into about video clip subscribe channel please watch hello hi bhaiyon dosto doston guys friends welcome').split(' '));
const VOWEL = /[aeiouy]/i;
/** One word that must not become a tag/hashtag on its own. */
const onlyJunkParts = (x: string): boolean => { const ok = Array<boolean>(x.length + 1).fill(false); ok[0] = true; for (let i = 1; i <= x.length; i++) for (let j = Math.max(0, i - 8); j < i; j++) if (ok[j] && JUNK.has(x.slice(j, i))) { ok[i] = true; break; } return ok[x.length]!; }; // "unnisbees" = unnis+bees
export const isJunkWord = (w: string): boolean => { const x = w.toLowerCase().replace(/[^a-z0-9]/g, ''); return x.length < 3 || /^\d+$/.test(x) || JUNK.has(x) || !VOWEL.test(x) || /(.)\1{2,}/.test(x) || onlyJunkParts(x); };
/** A phrase is junk when it has no meaningful word at all, or is only filler. Roman script only. */
export const isJunkPhrase = (p: string): boolean => { if (/[^\u0000-ɏ -⃿]/.test(p)) return true; const ws = p.toLowerCase().split(/\s+/).filter(Boolean); return !ws.length || ws.every(isJunkWord) || ws.length > 8; };
/** "kal ki baat" -> #KalKiBaat ; null when unusable (junk single word, too long, no letters). */
export function toHashtag(p: string): string | null {
  const ws = p.replace(/^#/, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!ws.length || (ws.length === 1 && isJunkWord(ws[0]!)) || ws.every(isJunkWord) || /[^\u0000-ɏ]/.test(ws.join(''))) return null;
  const raw = p.replace(/^#/, '').trim(); const tag = !/\s/.test(raw) && /[a-z][A-Z]/.test(raw) ? raw[0]!.toUpperCase() + raw.slice(1).replace(/[^\p{L}\p{N}]/gu, '') : ws.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(''); return tag.length >= 4 && tag.length <= 30 ? '#' + tag : null;
}
const uniq = <T>(a: T[], key: (x: T) => string = (x) => String(x)) => { const seen = new Set<string>(); return a.filter((x) => { const k = key(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
/** Tags field of YouTube: whole list max 500 chars (multi-word tags count 2 extra for the quotes). */
export function fitTags(tags: string[], max = 480): string[] { const out: string[] = []; let n = 0; for (const t of tags) { const c = t.length + (/\s/.test(t) ? 2 : 0) + (out.length ? 1 : 0); if (n + c > max) continue; out.push(t); n += c; } return out; }

export interface Pack { keywords: string[]; tags: string[]; hashtags: string[]; highlights: string[]; searches: string[]; related: string[] }
/**
 * Build the full SEO package FROM THIS VIDEO: its own keyphrases + the AI's tags + what people really type in YouTube's search box
 * (public autocomplete for the strongest seeds; best effort, cached 24 h). Everything is junk-filtered; nothing is invented.
 * Limits: 50 keywords, tags that fit YouTube's 500-char field, 50 hashtags (YouTube drops ALL hashtags above 60), 10 highlights.
 */
export async function buildPack(store: Store | null, i: { seeds: string[]; aiTags?: string[]; aiHashtags?: string[]; aiSearches?: string[]; highlights?: string[]; lang: string; hashtagsExtra?: string[]; fetchFn?: typeof fetch }): Promise<Pack> {
  const ai = [...(i.aiTags ?? []), ...(i.aiSearches ?? [])]; // transcript-word seeds only when the AI gave too little: a mis-heard transcript ('poori chamka boosa') must not become tags
  const base = uniq([...ai, ...(ai.length >= 8 ? [] : i.seeds)].map((x) => x.replace(/^#/, '').replace(/\s+/g, ' ').trim().toLowerCase()).filter((x) => x.length >= 3 && x.length <= 50 && !isJunkPhrase(x)));
  const sugSeeds = base.filter((x) => { const n = x.split(' ').length; return n >= 2 && n <= 3; }).slice(0, 6); /* 2-3 word topics only: a single word ('pani') pulls in unrelated searches ('pani puri') */ const heard: string[] = [];
  const res = await Promise.all(sugSeeds.map((s) => suggestKeywords(store, s, { hl: i.lang === 'en' ? 'en' : 'hi', max: 10, fetchFn: i.fetchFn }).then((r) => relevantSuggestions(r, s)).catch(() => [] as string[])));
  for (const r of res) heard.push(...r.map((x) => x.toLowerCase()).filter((x) => !isJunkPhrase(x)));
  const keywords = uniq([...base, ...heard]).slice(0, 50);
  const ht = uniq([...(i.hashtagsExtra ?? []), ...(i.aiHashtags ?? []).map(toHashtag), ...keywords.map(toHashtag)].filter((x): x is string => !!x && !isJunkPhrase(x.slice(1))), (x) => x).slice(0, 49);
  const hashtags = uniq(['#Shorts', ...ht], (x) => x).slice(0, 50);
  return { keywords, tags: fitTags(keywords), hashtags, highlights: uniq((i.highlights ?? []).map((x) => x.trim()).filter(Boolean)).slice(0, 10), searches: keywords.slice(0, 8), related: uniq([...heard, ...keywords]).slice(0, 12) };
}
