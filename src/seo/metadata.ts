import { buildBrief, composeDescription, type Brief, type DescParts } from './brief.ts';
import { scoreMetadata, type SeoScore } from './score.ts';
import type { Cue } from '../analysis/transcript.ts';
import { localMetadata } from './local.ts';
export interface MetaInput { transcript: string; category: string; language: string; sourceTitle?: string; channelName?: string; ownerLinks?: { label: string; url: string }[]; hashtagsExtra?: string[]; hook?: string; cues?: Cue[]; clipStart?: number; duration?: number; part?: { no: number; total: number } | null; relatedExtra?: string[] }
export interface Metadata { titles: string[]; title: string; description: string; tags: string[]; hashtags: string[]; keywords: string[]; language: string; thumbnailText: string; source: 'template' | 'llm'; warnings: string[]; seo?: SeoScore & { chapters: number }; parts?: DescParts; generic?: boolean }

const STOP = new Set('the a an and or of to in on is are was were be this that it for with as at by from kya hai hain ka ki ke ko se me mein aur ye yeh woh wo nahi toh to bhi hi kar karo raha rahi tha the thi ek par pe hum tum aap mai main mera meri'.split(' '));

/** Top keywords by frequency (no stuffing: max n, min length 4). */
export function extractKeywords(text: string, n = 8): string[] {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}

/**
 * Honest template metadata (works offline/free). Titles use transcript keywords when present; never invent facts, links or handles.
 * Links are included ONLY from `ownerLinks` (owner-verified config).
 */
export function buildMetadata(i: MetaInput): Metadata {
  const warnings: string[] = [];
  if (i.transcript.trim().split(/\s+/).length >= 8) { // enough real speech: use the local text engine (keyphrases, hook sentence, summary)
    const lang = (['hi', 'hinglish', 'en'].includes(i.language) ? i.language : 'unknown') as 'hi' | 'hinglish' | 'en' | 'unknown';
    const kws0 = extractKeywords(i.transcript, 6); const hashtags = ['#Shorts', ...(i.hashtagsExtra ?? []), ...kws0.slice(0, 3).map((k) => '#' + k.replace(/\s+/g, ''))].filter((h, idx, a) => a.indexOf(h) === idx).slice(0, 5);
    const lm = localMetadata({ transcript: i.transcript, category: i.category, language: lang, hook: i.hook, channelName: i.channelName, sourceTitle: i.sourceTitle, hashtags });
    const brief: Brief = buildBrief({ transcript: i.transcript, cues: i.cues, clipStart: i.clipStart, duration: i.duration });
    if (!i.ownerLinks?.length) warnings.push('no owner links configured: none added (by design, never invented)');
    const tagKw = lm.keyphrases.map((k) => '#' + k.replace(/\s+/g, '')).slice(0, 3); const ht = [...new Set([...hashtags, ...tagKw])].slice(0, 5);
    const kwAll = [...lm.keyphrases, ...brief.keyphrases].filter((k, x, arr) => arr.indexOf(k) === x);
    const parts: DescParts = { about: brief.summary || lm.description.split('\n')[0]!, highlights: brief.highlights, chapters: brief.chapters, searches: kwAll.slice(0, 5), related: [...(i.relatedExtra ?? []), ...kwAll.slice(0, 6).map((k) => '#' + k.replace(/\s+/g, ''))].filter((x, y, arr) => arr.indexOf(x) === y).slice(0, 6), hashtags: ht, sourceTitle: i.sourceTitle, channelName: i.channelName, links: i.ownerLinks, lang, part: i.part ?? null };
    const md0: Metadata = { titles: lm.titles.map((t) => t.slice(0, 95)), title: `${lm.titles[0]!.slice(0, 90)} #Shorts`.slice(0, 100), description: composeDescription(parts), tags: lm.tags, hashtags: ht, keywords: lm.keyphrases, language: i.language, thumbnailText: lm.thumbnailText, source: 'template', warnings, parts };
    return { ...md0, seo: { ...scoreMetadata(md0, { keyphrases: kwAll, hasChapters: brief.chapters.length >= 3, durationSec: i.duration, transcriptWords: brief.words }), chapters: brief.chapters.length } };
  }
  const kws = extractKeywords(i.transcript || (i.sourceTitle ?? ''), 8);
  // No speech to work from: never invent a title. Use the source title (or channel name) and say so.
  const kw0 = kws[0]; const titles: string[] = [];
  if (i.sourceTitle) titles.push(`${i.sourceTitle.slice(0, 70)} | Best Moment`);
  titles.push(`${i.channelName ? i.channelName + ' — ' : ''}Best Moment`);
  const clean = titles.map((t) => t.slice(0, 95)).filter((t, idx, a) => a.indexOf(t) === idx);
  const title = `${clean[0]!} #Shorts`.slice(0, 100);
  const hashtags = ['#Shorts', ...(i.hashtagsExtra ?? []), ...kws.slice(0, 3).map((k) => '#' + k.replace(/\s+/g, ''))].filter((h, idx, a) => a.indexOf(h) === idx).slice(0, 5);
  const tags = [...kws, ...(i.category !== 'general' ? [i.category] : []), 'shorts', 'best moments', ...(i.channelName ? [i.channelName] : [])].filter((t, idx, a) => a.indexOf(t) === idx).slice(0, 15);
  const lines: string[] = [];
  lines.push(i.transcript ? `${i.transcript.slice(0, 160).trim()}${i.transcript.length > 160 ? '…' : ''}` : 'Is video ka sabse khaas moment.');
  lines.push('');
  if (i.sourceTitle) lines.push(`Poori video: ${i.sourceTitle}${i.channelName ? ` (${i.channelName})` : ''}`);
  if (i.ownerLinks?.length) { lines.push(''); for (const l of i.ownerLinks) lines.push(`${l.label}: ${l.url}`); }
  lines.push('', hashtags.join(' '));
  if (!i.transcript) warnings.push('no transcript: description/keywords are generic');
  if (!i.ownerLinks?.length) warnings.push('no owner links configured: none added (by design, never invented)');
  const thumbnailText = (kw0 ? kw0.toUpperCase() : (clean[0] ?? 'WATCH').replace(/[^\p{L}\p{N} ]/gu, '').split(' ').slice(0, 3).join(' ')).slice(0, 18);
  return { titles: clean, title, description: lines.join('\n').slice(0, 4900), tags, hashtags, keywords: kws, language: i.language, thumbnailText, source: 'template', warnings, generic: true };
}

export function validateMetadata(m: Metadata): string[] {
  const errs: string[] = [];
  if (m.title.length === 0 || m.title.length > 100) errs.push('title length must be 1..100');
  if (m.description.length > 5000) errs.push('description > 5000');
  if (m.tags.join(',').length > 480) errs.push('tags > 500 chars');
  if (m.hashtags.length > 15) errs.push('too many hashtags (YouTube ignores all if >15)');
  return errs;
}

/** Advisory (never blocking) title/hook checks, after the MIT-licensed youtube-agent-skill "title/thumbnail linter" idea: only things visible in the words themselves. */
export function lintPackage(m: { title: string; description?: string }, hookText?: string | null): string[] {
  const w: string[] = []; const t = m.title.replace(/#\S+/g, '').trim();
  if (t.length > 60) w.push(`title ${t.length} chars: mobile search cuts after ~60`);
  const letters = t.replace(/[^A-Za-z]/g, ''); if (letters.length >= 8 && letters === letters.toUpperCase()) w.push('title is ALL CAPS');
  if (/^(video|clip|short|funny|best|new)\b[\s\d:.-]*$/i.test(t)) w.push('title is vague');
  if (hookText && hookText.trim().toLowerCase() === t.toLowerCase()) w.push('on-screen hook repeats the title word-for-word (waste of the first 3 seconds)');
  if ((m.description ?? '').trim().length < 40) w.push('description is very short (add what the clip is about)');
  return w;
}

/** Series clips: add "(Part n/N)" to the title and a line to the description. No-op for single clips. */
export function withPart(md: Metadata, part?: { no: number; total: number } | null): Metadata {
  if (!part?.no || !part.total) return md;
  const tag = `(Part ${part.no}/${part.total})`;
  const strip = (t: string) => t.replace(/\s*#Shorts\s*$/i, '');
  const titles = md.titles.map((t) => `${t.slice(0, 80)} ${tag}`.slice(0, 95));
  const title = `${strip(md.title).slice(0, 78)} ${tag} #Shorts`.slice(0, 100);
  const note = part.no < part.total ? `Part ${part.no}/${part.total} — agla part dekhna mat bhoolna!` : `Part ${part.no}/${part.total} — series ka last part.`;
  return { ...md, titles, title, description: md.description.includes(`Part ${part.no}/${part.total} —`) ? md.description : `${note}\n\n${md.description}`.slice(0, 4900) };
}
