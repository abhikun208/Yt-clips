/** Objective, checkable title problems (no model "confidence" self-score). A provider whose title has issues is not final while another provider is still untried. */
export function titleIssues(title: string, sourceTitle?: string): string[] {
  const t = title.replace(/\s*#shorts\s*$/i, '').trim(); const issues: string[] = [];
  if (t.length > 62) issues.push('longer than 60 chars (phones cut it)');
  if (t.length < 12) issues.push('too short');
  if (/amazing moments?|must watch|you won'?t believe|best video|part \d+ of|full video|subscribe/i.test(t)) issues.push('generic/clickbait filler');
  const letters = t.replace(/[^A-Za-z]/g, ''); if (letters.length > 8 && letters === letters.toUpperCase()) issues.push('ALL CAPS');
  if (sourceTitle && t.toLowerCase() === sourceTitle.trim().toLowerCase()) issues.push('copy of the source title');
  return issues;
}
