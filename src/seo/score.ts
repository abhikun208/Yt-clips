import type { Metadata } from './metadata.ts';

export interface SeoScore { ctr: number; seo: number; issues: string[]; note: string }
/**
 * A transparent CHECKLIST score (0-100) of known good practice, not a prediction: nobody can promise views.
 * ctr = how clickable title + thumbnail text are; seo = how well title/description/tags carry the real topic keywords.
 */
export function scoreMetadata(m: Metadata, ctx: { keyphrases?: string[]; hasChapters?: boolean; durationSec?: number; transcriptWords?: number } = {}): SeoScore {
  const issues: string[] = []; let ctr = 0, seo = 0;
  const t = m.title.replace(/#shorts/i, '').trim(); const kp = (ctx.keyphrases ?? m.keywords ?? []).map((x) => x.toLowerCase()); const low = t.toLowerCase();
  const first40 = low.slice(0, 40);
  if (t.length >= 30 && t.length <= 70) ctr += 20; else issues.push(`title length ${t.length} (best 30-70 chars)`);
  if (kp.some((k) => first40.includes(k))) { ctr += 20; seo += 20; } else issues.push('main keyword not in the first 40 chars of the title');
  if (/\d/.test(t) || /[?!]/.test(t) || /\b(kaise|kyun|kya|why|how|secret|sach|truth|clutch|boss|insane|crazy)\b/i.test(t)) ctr += 15; else issues.push('title has no curiosity/number hook');
  const emo = (t.match(/\p{Extended_Pictographic}/gu) ?? []).length; if (emo >= 1 && emo <= 2) ctr += 10; else issues.push(emo ? 'too many emojis in the title' : 'no emoji in the title');
  if (!/^[^a-z\p{L}]*[A-Z0-9\s\W]{25,}$/u.test(t)) ctr += 10; else issues.push('title is ALL CAPS');
  const tw = m.thumbnailText.trim().split(/\s+/).filter(Boolean).length; if (tw >= 1 && tw <= 4 && m.thumbnailText.length <= 24) ctr += 15; else issues.push('thumbnail text should be 1-4 short words');
  if (m.titles.length >= 3) ctr += 10; else issues.push('fewer than 3 title options (nothing to A/B)');
  const d = m.description; const head = d.slice(0, 160).toLowerCase();
  if (kp.some((k) => head.includes(k))) seo += 20; else issues.push('description opening lacks the main keyword');
  if (m.hashtags.length >= 3 && m.hashtags.length <= 5) seo += 15; else issues.push('use 3-5 hashtags');
  const tl = m.tags.join(',').length; if (m.tags.length >= 5 && tl <= 480) seo += 15; else issues.push(m.tags.length < 5 ? 'fewer than 5 tags' : 'tags exceed 480 chars');
  if (d.length >= 250) seo += 10; else issues.push('description is very short');
  if ((ctx.durationSec ?? 0) >= 30) { if (ctx.hasChapters) seo += 10; else issues.push('no time map (clip ≥30 s but too little speech for chapters)'); } else seo += 10;
  if (/^\s*#/.test(d)) issues.push('description starts with hashtags'); else seo += 10;
  if (m.source === 'template' && (ctx.transcriptWords ?? 99) < 8) issues.push('not enough speech: metadata is generic');
  return { ctr: Math.min(100, ctr), seo: Math.min(100, seo), issues, note: 'checklist score of best practice, not a view prediction' };
}
