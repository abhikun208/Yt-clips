import type { ResolvedContentProfile } from '../content-profile.ts';

/**
 * Content-type and sub-type detection from the transcript/title (English + Roman Hinglish). Pure and cheap (no model, Termux-friendly).
 * It only ever picks an existing selection profile (select.ts scoring); it never touches editing. A manual channel profile always wins:
 * this runs only for contentProfile = 'auto'. Weak evidence -> 'general' (never a guess).
 */
export interface ContentType { profile: ResolvedContentProfile; words: string[]; subs?: Record<string, string[]> }
export const CONTENT_TYPES: Record<string, ContentType> = {
  gaming: { profile: 'gaming', words: ['gameplay', 'headshot', 'clutch', 'squad', 'ranked', 'rank push', 'lobby', 'respawn', 'loadout', 'killfeed', 'bgmi', 'free fire', 'valorant', 'minecraft', 'fortnite', 'gta', 'pubg', 'call of duty', 'booyah', 'one tap', 'noob', 'gg', 'match', 'boss fight'],
    subs: { clutch: ['clutch', '1v1', '1v2', '1v3', '1v4'], kills: ['headshot', 'kill', 'ace', 'wipe', 'one tap'], funny: ['lol', 'haha', 'funny', 'hasi'], fail: ['fail', 'bug', 'glitch', 'noob'], rage: ['rage', 'gussa', 'angry', 'tilt'], tutorial: ['tip', 'trick', 'sensitivity', 'settings', 'guide'], horror: ['horror', 'jumpscare', 'scary', 'darr'], esports: ['tournament', 'finals', 'scrim', 'esports', 'team'], challenge: ['challenge', 'only', 'no scope'] } },
  podcast: { profile: 'podcast', words: ['podcast', 'episode', 'my guest', 'guest', 'welcome back', 'interview', 'conversation', 'host', 'debate', 'opinion', 'tell me', 'in your journey', 'baat karte hain'],
    subs: { debate: ['debate', 'disagree', 'argument', 'sahi nahi'], interview: ['interview', 'my guest', 'tell us'], motivation: ['discipline', 'mindset', 'success', 'consistency'], emotional: ['emotional', 'cried', 'struggle', 'dukh'] } },
  vlog: { profile: 'vlog', words: ['vlog', 'today we', 'aaj hum', 'trip', 'travel', 'hotel', 'airport', 'restaurant', 'beach', 'daily routine', 'morning routine', 'road trip', 'adventure', 'street food', 'mall', 'wedding', 'event'],
    subs: { travel: ['trip', 'travel', 'hotel', 'airport', 'beach', 'flight'], food: ['food', 'restaurant', 'street food', 'taste', 'recipe', 'cooking'], daily: ['daily routine', 'morning routine', 'my day'], event: ['event', 'wedding', 'party'], fitness: ['workout', 'gym', 'reps', 'protein'] } },
  educational: { profile: 'educational', words: ['how to', 'tutorial', 'step by step', 'learn', 'explained', 'lesson', 'for example', 'formula', 'concept', 'kaise', 'samjho', 'seekho', 'tips', 'mistake', 'beginners', 'fact', 'did you know', 'history', 'science', 'research', 'study', 'tech', 'ai model', 'review', 'compared', 'price', 'budget', 'invest', 'stock', 'news', 'breaking'],
    subs: { tutorial: ['how to', 'tutorial', 'step by step', 'kaise', 'seekho'], facts: ['did you know', 'fact', 'research', 'study'], news: ['news', 'breaking', 'update', 'announced'], tech: ['ai', 'tech', 'app', 'phone', 'model', 'chatgpt'], review: ['review', 'compared', 'vs', 'worth it'], finance: ['invest', 'stock', 'money', 'budget', 'profit'], history: ['history', 'ancient', 'war', 'empire'] } },
  comedy: { profile: 'comedy', words: ['joke', 'funny', 'prank', 'meme', 'skit', 'roast', 'comedy', 'lol', 'haha', 'mazak', 'hasi'], subs: { prank: ['prank'], roast: ['roast'], skit: ['skit', 'sketch'], meme: ['meme'] } },
  reaction: { profile: 'reaction', words: ['reaction', 'reacting', 'react', 'first time watching', 'watching this', 'react karte'], subs: {} },
  story: { profile: 'vlog', words: ['once upon', 'story', 'kahani', 'suddenly', 'then he', 'then she', 'and then', 'night', 'raat', 'ghost', 'suspense', 'anime', 'plot twist'], subs: { horror: ['ghost', 'scary', 'bhoot', 'darr'], suspense: ['suspense', 'plot twist', 'mystery'], anime: ['anime', 'manga', 'episode'] } },
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const has = (text: string, w: string) => new RegExp(`(^|[^a-z0-9])${esc(w)}([^a-z0-9]|$)`, 'i').test(text);
const hits = (text: string, ws: string[]) => ws.filter((w) => has(text, w));

export interface Detected { type: string; profile: ResolvedContentProfile; subType: string | null; confidence: number; evidence: string[] }
export const MIN_EVIDENCE = 3; // distinct words needed; one stray word never decides

export function detectContent(text: string, title = ''): Detected {
  const t = `${title}\n${text}`.toLocaleLowerCase(); const ranked = Object.entries(CONTENT_TYPES).map(([type, d]) => ({ type, d, h: hits(t, d.words) })).sort((a, b) => b.h.length - a.h.length);
  const top = ranked[0]!; const second = ranked[1]?.h.length ?? 0;
  if (top.h.length < MIN_EVIDENCE || top.h.length === second) return { type: 'general', profile: 'general', subType: null, confidence: 0, evidence: [] };
  let subType: string | null = null; let best = 0; for (const [s, ws] of Object.entries(top.d.subs ?? {})) { const n = hits(t, ws).length; if (n > best) { best = n; subType = s; } }
  return { type: top.type, profile: top.d.profile, subType, confidence: +Math.min(1, (top.h.length - second) / 6).toFixed(2), evidence: top.h.slice(0, 6) };
}
