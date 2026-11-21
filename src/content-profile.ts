export const CONTENT_PROFILES = [
  'general', 'auto', 'gaming', 'only_gaming', 'vlog', 'mixed', 'podcast',
  'comedy', 'reaction', 'educational', 'custom',
] as const;

export type ContentProfile = typeof CONTENT_PROFILES[number];
export type ResolvedContentProfile = Exclude<ContentProfile, 'auto'>;

export function isContentProfile(value: unknown): value is ContentProfile {
  return typeof value === 'string' && (CONTENT_PROFILES as readonly string[]).includes(value);
}
