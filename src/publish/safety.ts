/**
 * Pre-upload safety screen on the clip's TRANSCRIPT/TITLE text. This is a keyword heuristic, NOT an AI vision/audio model:
 * it cannot see nudity/violence in pixels or identify copyrighted music. Severity "block" stops the upload (QC_FAILED);
 * "warn" is shown to the owner but does not block. Lists are small and conservative on purpose.
 */
export interface Risk { severity: 'block' | 'warn'; category: string; match: string }
const RULES: { severity: Risk['severity']; category: string; re: RegExp }[] = [
  { severity: 'block', category: 'self_harm_instruction', re: /\b(how to (kill|hang) yourself|suicide method|kill yourself)\b/i },
  { severity: 'block', category: 'sexual_content', re: /\b(porn|xxx|nude (video|photo)s?|sex tape|onlyfans leak)\b/i },
  { severity: 'block', category: 'hate', re: /\b(kill all (the )?\w+|death to (all )?\w+|\w+ (are|is) (vermin|subhuman))\b/i },
  { severity: 'block', category: 'violent_threat', re: /\b(i will (kill|shoot|stab) (you|him|her|them)|bomb (the|a) (school|temple|mosque|church))\b/i },
  { severity: 'warn', category: 'medical_claim', re: /\b(cures? (cancer|diabetes|covid)|guaranteed cure|100% cure)\b/i },
  { severity: 'warn', category: 'financial_promise', re: /\b(guaranteed (profit|returns?)|double your money|risk[- ]free (profit|income))\b/i },
  { severity: 'warn', category: 'profanity', re: /\b(madarchod|bhenchod|chutiya|fuck|bitch)\b/i },
  { severity: 'warn', category: 'violence_graphic', re: /\b(beheading|gore|dead body|lynching)\b/i },
  { severity: 'warn', category: 'music_copyright', re: /\b(official (music )?video|lyrics?|full song|karaoke)\b/i },
];
export function screenText(text: string): Risk[] {
  const out: Risk[] = []; for (const r of RULES) { const m = r.re.exec(text); if (m) out.push({ severity: r.severity, category: r.category, match: m[0].slice(0, 40) }); } return out;
}
