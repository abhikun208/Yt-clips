export interface MetaInput { transcript: string; category: string; language: string; sourceTitle?: string; channelName?: string; ownerLinks?: { label: string; url: string }[]; hashtagsExtra?: string[] }
export interface Metadata { titles: string[]; title: string; description: string; tags: string[]; hashtags: string[]; keywords: string[]; language: string; thumbnailText: string; source: 'template' | 'llm'; warnings: string[] }

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

const EMO_TITLE: Record<string, string[]> = {
  funny: ['Ye Moment Dekh Ke Hasi Nahi Rukegi 😂', 'Itna Funny Moment! 😂'],
  sad: ['Dil Chhoo Lene Wala Moment 💔', 'Ye Dekh Ke Aankhein Nam Ho Jayengi'],
  happy: ['Khushi Ka Pal ❤️', 'Dil Khush Kar Dene Wala Moment'],
  shock: ['Ye Kya Ho Gaya? 😱', 'Iski Umeed Nahi Thi! 😱'],
  aggressive: ['Gussa Jab Hadd Paar Kar Gaya 🔥', 'Garma-Garmi Ka Full Scene 🔥'],
  cute: ['Itna Cute Ki Dil Pighal Jaye 🥰', 'Cutest Moment Aaj Ka 🥰'],
  high_energy: ['Full Josh Wala Moment 🔥', 'Ye Energy Dekhi Kya? 🔥'],
};

/**
 * Honest template metadata (works offline/free). Titles use transcript keywords when present; never invent facts, links or handles.
 * Links are included ONLY from `ownerLinks` (owner-verified config).
 */
export function buildMetadata(i: MetaInput): Metadata {
  const warnings: string[] = [];
  const kws = extractKeywords(i.transcript, 8);
  const base = EMO_TITLE[i.category] ?? ['Ye Moment Miss Mat Karna ✨'];
  const kw0 = kws[0];
  const titles: string[] = [];
  for (const b of base) titles.push(b);
  if (kw0) titles.push(`${kw0[0]!.toUpperCase()}${kw0.slice(1)} Ka Sach — Poora Dekho 👀`);
  if (i.sourceTitle) titles.push(`${i.sourceTitle.slice(0, 60)} | Best Moment`);
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
  return { titles: clean, title, description: lines.join('\n').slice(0, 4900), tags, hashtags, keywords: kws, language: i.language, thumbnailText, source: 'template', warnings };
}

export function validateMetadata(m: Metadata): string[] {
  const errs: string[] = [];
  if (m.title.length === 0 || m.title.length > 100) errs.push('title length must be 1..100');
  if (m.description.length > 5000) errs.push('description > 5000');
  if (m.tags.join(',').length > 480) errs.push('tags > 500 chars');
  if (m.hashtags.length > 15) errs.push('too many hashtags (YouTube ignores all if >15)');
  return errs;
}
