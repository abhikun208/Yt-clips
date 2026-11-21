import type { ContentProfile, ResolvedContentProfile } from '../content-profile.ts';

const STRONG_GAMING_TERMS = [
  'booyah', 'headshot', 'clutch', 'squad wipe', 'one tap', 'onetap', '1v1', '1v2', '1v3', '1v4',
  'chicken dinner', 'free fire', 'bgmi', 'rank push', 'killfeed', 'awm',
];
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const STRONG_GAMING_PATTERNS = STRONG_GAMING_TERMS.map((term) => new RegExp(`(^|[^a-z0-9])${escaped(term)}([^a-z0-9]|$)`, 'i'));

/** Require two distinct, high-specificity gaming terms; generic words such as "down" are not enough. */
export function hasStrongGamingEvidence(transcript: string): boolean {
  const text = transcript.toLocaleLowerCase();
  return STRONG_GAMING_PATTERNS.filter((pattern) => pattern.test(text)).length >= 2;
}

/** Auto mode only selects gaming when the transcript has multiple distinct gaming callouts. */
export function resolveContentProfile(configured: ContentProfile | undefined, transcript: string): ResolvedContentProfile {
  if (configured !== 'auto') return configured ?? 'general';
  return hasStrongGamingEvidence(transcript) ? 'gaming' : 'general';
}
