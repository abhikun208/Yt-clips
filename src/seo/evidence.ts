/**
 * Evidence labels for research insights, so the owner can see what is real data and what is a guess.
 *  VERIFIED_DATA = fetched from a real source in this run (YouTube suggestions, news headlines) - the fetch is real, its relevance to this clip is not proven
 *  ESTIMATE      = computed by our own rules/heuristics (keyword frequency, SEO score)
 *  AI_GUESS      = written by a language model, not measured
 *  UNAVAILABLE   = tried or needed, but no data (offline, no AI configured, empty answer)
 */
export type EvidenceLabel = 'VERIFIED_DATA' | 'ESTIMATE' | 'AI_GUESS' | 'UNAVAILABLE';
export interface ResearchInsight { topic: 'keywords' | 'search_suggestions' | 'trends' | 'title_text' | 'seo_score'; label: EvidenceLabel; source: string; detail: string }
export function buildResearch(i: { keywords: string[]; suggestions: string[]; trendsTried: boolean; trends: string[]; generatedBy?: string; seoScore?: number | null }): ResearchInsight[] {
  const out: ResearchInsight[] = [];
  out.push(i.keywords.length ? { topic: 'keywords', label: 'ESTIMATE', source: 'transcript word frequency', detail: i.keywords.slice(0, 5).join(', ') } : { topic: 'keywords', label: 'UNAVAILABLE', source: 'transcript', detail: 'no transcript, so no keywords' });
  out.push(i.suggestions.length ? { topic: 'search_suggestions', label: 'VERIFIED_DATA', source: 'YouTube search autocomplete (fetched)', detail: i.suggestions.slice(0, 3).join(' | ') + ' (shows what people type, not that this clip will rank)' } : { topic: 'search_suggestions', label: 'UNAVAILABLE', source: 'YouTube search autocomplete', detail: 'nothing returned (offline, blocked or no match)' });
  out.push(i.trends.length ? { topic: 'trends', label: 'VERIFIED_DATA', source: 'news RSS headlines (fetched)', detail: i.trends.slice(0, 3).join(' | ') + ' (word overlap with the clip, relevance is an estimate)' } : { topic: 'trends', label: 'UNAVAILABLE', source: 'news RSS headlines', detail: i.trendsTried ? 'no related headline found' : 'not fetched (no AI configured)' });
  const g = i.generatedBy ?? ''; out.push(!g || /^rules|^FALLBACK/i.test(g) ? { topic: 'title_text', label: 'ESTIMATE', source: 'rule templates', detail: g || 'template text' } : { topic: 'title_text', label: 'AI_GUESS', source: g, detail: 'title/description written by a model, not measured' });
  out.push(typeof i.seoScore === 'number' ? { topic: 'seo_score', label: 'ESTIMATE', source: 'own SEO checklist score', detail: `${i.seoScore}/100: a checklist, not a ranking prediction` } : { topic: 'seo_score', label: 'UNAVAILABLE', source: 'own SEO checklist', detail: 'not computed' });
  return out;
}
