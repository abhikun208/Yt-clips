/**
 * Rights / originality screen (TEXT ONLY: transcript + title). It cannot see the picture: no OCR, so on-screen watermarks are NOT detected.
 * It only raises review flags and logs a decision; it never rejects or edits a clip. Owner decides.
 */
export type RightsFlag = 'other_handle' | 'credit_text' | 'no_commentary';
export interface RightsResult { decision: 'ok' | 'note' | 'review'; flags: RightsFlag[]; handles: string[]; credits: string[]; wordsPerSec: number | null; reasons: string[]; limit: string }
const CREDIT = [/all rights reserved/i, /©/, /\bcopyright\b/i, /\bwatermark\b/i, /\bcredits? (?:to|goes to)\b/i, /\bvia\s+@/i, /\bsource\s*:/i, /\bsubscribe to\s+[a-z0-9_.]{3,}/i, /\bfollow\s+@/i, /\bsubscribe karo\s+[a-z0-9_.]{3,}/i];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function rightsScreen(input: { transcript: string; title?: string; duration: number; ownNames: string[] }): RightsResult {
  const text = `${input.title ?? ''}\n${input.transcript}`; const own = new Set(input.ownNames.map(norm).filter(Boolean));
  const handles = [...new Set([...text.matchAll(/(^|[^\w])@([a-z0-9_.]{3,30})/gi)].map((m) => m[2]!.toLowerCase()))].filter((h) => ![...own].some((o) => norm(h).includes(o) || o.includes(norm(h))));
  const credits = CREDIT.map((r) => text.match(r)?.[0]).filter((x): x is string => !!x).map((x) => x.trim().slice(0, 40));
  const words = input.transcript.split(/\s+/).filter(Boolean).length; const wps = input.duration > 0 ? +(words / input.duration).toFixed(2) : null;
  const flags: RightsFlag[] = []; const reasons: string[] = [];
  if (handles.length) { flags.push('other_handle'); reasons.push(`mentions other creator handle(s): ${handles.slice(0, 3).map((h) => '@' + h).join(', ')}`); }
  if (credits.length) { flags.push('credit_text'); reasons.push(`credit/copyright wording: ${credits.slice(0, 3).join(' | ')}`); }
  if (input.duration >= 15 && wps !== null && wps < 0.4) { flags.push('no_commentary'); reasons.push(`almost no speech (${wps} words/s): check there is own commentary/transformation`); }
  const decision = flags.includes('other_handle') || flags.includes('credit_text') ? 'review' : flags.length ? 'note' : 'ok';
  return { decision, flags, handles, credits, wordsPerSec: wps, reasons, limit: 'text-only: on-screen watermarks/logos are not detected (no OCR)' };
}
