import { hookScore } from '../analysis/textsignals.ts';

/** Local (no keys, no network) text intelligence for titles/descriptions/tags. Deterministic. */
const STOP_LIST = `the a an and or of to in on is are was were be been being this that these those it its for with as at by from but not no yes so if then than too very can could will would should may might do does did have has had i you he she we they me him her us them my your his our their what which who whom how why when where there here about into over under again more most some any each other such only own same just also now one two out up down off all both few
kya hai hain tha thi the ka ki ke ko se me mein par pe aur ya ye yeh woh wo vo nahi nahin nhi toh to bhi hi kar karo karna kare kiya kiye raha rahi rahe hota hoti hote hua hui hue ek hum tum aap mai main mera meri mere tera teri tere apna apni apne iss uss isko usko jo jab tab agar lekin magar kyunki isliye abhi bas sirf bahut kuch koi kaun kab kahan kaise kyu kyun waise phir fir aise jaise wala wali wale liye saath sath baad pehle upar neeche andar bahar
है हैं था थी थे का की के को से में पर और या ये यह वह वो नहीं भी ही कर करो करना किया रहा रही रहे होता होती होते हुआ हुई हुए एक हम तुम आप मैं मेरा मेरी मेरे अपना अपनी अपने जो जब तब अगर लेकिन मगर क्योंकि इसलिए अभी बस सिर्फ बहुत कुछ कोई कौन कब कहाँ कैसे क्यों फिर ऐसे जैसे वाला वाली वाले लिए साथ बाद पहले`.split(/\s+/);
const STOP = new Set(STOP_LIST);
const FILLER = new Set('um uh umm hmm like basically actually literally yaar bhai guys dosto toh matlab'.split(' '));

export const tokenize = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{M}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
const isContent = (w: string) => !STOP.has(w) && !FILLER.has(w) && w.length >= 3 && !/^\d+$/.test(w);

/** Key phrases (1-3 words): content words, no stop-word edges, scored by frequency x length bonus x early-position bonus. */
export function keyphrases(text: string, n = 8): { phrase: string; score: number }[] {
  const toks = tokenize(text); const score = new Map<string, number>(); const total = toks.length || 1;
  for (let i = 0; i < toks.length; i++) {
    for (let len = 1; len <= 3 && i + len <= toks.length; len++) {
      const g = toks.slice(i, i + len); if (!isContent(g[0]!) || !isContent(g[len - 1]!)) continue; if (g.some((w) => FILLER.has(w))) continue;
      const ph = g.join(' '); const pos = 1 + 0.4 * (1 - i / total); score.set(ph, (score.get(ph) ?? 0) + pos * (len === 1 ? 1 : len === 2 ? 1.8 : 2.2));
    }
  }
  // multi-word phrases must repeat (otherwise random adjacent words are noise); single words need >=1 hit
  const rep = new Map<string, number>(); for (const g of score.keys()) { let c = 0; let idx = 0; const hay = ' ' + toks.join(' ') + ' '; const needle = ' ' + g + ' '; while ((idx = hay.indexOf(needle, idx)) >= 0) { c++; idx += needle.length - 1; } rep.set(g, c); }
  const ranked = [...score.entries()].filter(([g]) => g.includes(' ') ? (rep.get(g) ?? 0) >= 2 : true).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  const out: { phrase: string; score: number }[] = [];
  for (const [g, s] of ranked) { if (out.some((o) => o.phrase.includes(g) || g.includes(o.phrase))) continue; out.push({ phrase: g, score: +s.toFixed(2) }); if (out.length >= n) break; }
  return out;
}

export const splitSentences = (t: string) => t.replace(/\s+/g, ' ').split(/(?<=[.!?।])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
const cap = (s: string) => s.replace(/(^|\s)(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
const shorten = (s: string, max: number) => { const t = s.replace(/\s+/g, ' ').trim().replace(/[.!?।,;:\s]+$/, ''); if (t.length <= max) return t; const cut = t.slice(0, max); const i = cut.lastIndexOf(' '); return (i > max * 0.6 ? cut.slice(0, i) : cut).replace(/[,;:\s]+$/, '') + '…'; };

/** Extractive summary: the k sentences richest in key phrases, kept in original order. */
export function summarize(text: string, k = 2, maxChars = 200): string {
  const sents = splitSentences(text); if (sents.length <= 1) return shorten(text, maxChars);
  const kp = keyphrases(text, 10); const sc = sents.map((s, i) => { const l = s.toLowerCase(); const sum = kp.reduce((a, p) => a + (l.includes(p.phrase) ? p.score : 0), 0); return { i, v: sum / Math.sqrt(Math.max(4, s.split(/\s+/).length)) }; });
  const pick = sc.sort((a, b) => b.v - a.v).slice(0, k).sort((a, b) => a.i - b.i).map((x) => sents[x.i]!);
  return shorten(pick.join(' '), maxChars);
}

export type Lang = 'hi' | 'hinglish' | 'en' | 'unknown';
const EMOJI: Record<string, string> = { funny: '😂', sad: '💔', happy: '❤️', shock: '😱', aggressive: '🔥', cute: '🥰', high_energy: '🔥', general: '👀' };
const PAT = {
  hi: { truth: (p: string) => `${p} का सच 😱`, q: (p: string) => `क्या आप ${p} के बारे में जानते हैं? 🤔`, cta: 'ऐसे और वीडियो के लिए फॉलो करें।', lead: 'इस वीडियो में' },
  hinglish: { truth: (p: string) => `${cap(p)} Ka Sach — Poora Dekho 👀`, q: (p: string) => `${cap(p)} Ke Baare Mein Ye Jaante The? 🤔`, cta: 'Aise aur videos ke liye follow karo.', lead: 'Is video mein' },
  en: { truth: (p: string) => `The Truth About ${cap(p)} 😱`, q: (p: string) => `Did You Know This About ${cap(p)}? 🤔`, cta: 'Follow for more.', lead: 'In this clip' },
  unknown: { truth: (p: string) => `${cap(p)} — Watch This 👀`, q: (p: string) => `${cap(p)}: Did You Know? 🤔`, cta: 'Follow for more.', lead: 'In this clip' },
} as const;

export interface LocalMeta { titles: string[]; title: string; description: string; tags: string[]; keyphrases: string[]; thumbnailText: string }
/** Build titles/description/tags from the clip's own transcript. Titles are scored (length, keyphrase, hook, emoji) and the best 3+ returned. */
export function localMetadata(o: { transcript: string; category: string; language: Lang; hook?: string; channelName?: string; sourceTitle?: string; hashtags: string[] }): LocalMeta {
  const L = PAT[o.language] ?? PAT.unknown; const emo = EMOJI[o.category] ?? '👀';
  const kp = keyphrases(o.transcript, 8); const top = kp[0]?.phrase;
  const sents = splitSentences(o.transcript); const hookSent = [o.hook, ...sents.slice(0, 3)].filter((x): x is string => !!x).map((s) => ({ s, h: hookScore(s) })).sort((a, b) => b.h - a.h)[0]?.s ?? '';
  const cands: string[] = [];
  const core = shorten(hookSent, 62); if (core.length >= 18) cands.push(`${core} ${emo}`);
  if (top) { cands.push(L.truth(top)); cands.push(L.q(top)); }
  if (kp[1]) cands.push(L.truth(`${kp[0]!.phrase} ${kp[1].phrase}`.slice(0, 40)));
  if (o.sourceTitle) cands.push(`${shorten(o.sourceTitle, 60)} | Best Moment`);
  const score = (t: string) => { let v = 0; const n = t.length; v += n >= 30 && n <= 70 ? 1 : n < 30 ? 0.4 : 0.6; if (top && t.toLowerCase().includes(top)) v += 1; v += hookScore(t) * 0.8; if (/\p{Extended_Pictographic}/u.test(t)) v += 0.3; return v; };
  const titles = [...new Set(cands.map((t) => shorten(t, 90)))].sort((a, b) => score(b) - score(a));
  if (!titles.length) titles.push(`Ye Moment Miss Mat Karna ${emo}`);
  const tags = [...new Set([...kp.map((k) => k.phrase), ...(o.category !== 'general' ? [o.category] : []), 'shorts', 'best moments', ...(o.channelName ? [o.channelName] : [])])].slice(0, 15);
  const lines = [summarize(o.transcript, 2, 220)];
  if (kp.length >= 2) lines.push('', `${L.lead}: ${kp.slice(0, 4).map((k) => k.phrase).join(', ')}.`);
  lines.push('', L.cta); if (o.hashtags.length) lines.push('', o.hashtags.join(' '));
  const thumbnailText = (top ? top : shorten(core, 24)).toUpperCase().slice(0, 22);
  return { titles: titles.slice(0, 4), title: titles[0]!, description: lines.join('\n').slice(0, 4800), tags, keyphrases: kp.map((k) => k.phrase), thumbnailText };
}
