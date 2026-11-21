import type { ClipFacts } from '../publish/machine.ts';
import { PLATFORM_CONSTRAINTS } from '../publish/machine.ts';

/**
 * Pure application of a per-destination metadata policy (stored on the source->account mapping, `source_destinations.metadata_json`): it can add its own title prefix/suffix and extra tags
 * or drop tags, WITHOUT touching the stored clip metadata or the video. It is applied to the facts of ONE upload only, so each
 * account/platform child job keeps independent metadata. Title is always clamped to the platform limit (the real title text is cut,
 * never the prefix/suffix the owner asked for).
 */
export interface MetaPolicy { titlePrefix?: string; titleSuffix?: string; addTags?: string[]; dropTags?: boolean }

const oneLine = (x: unknown, max: number): string => String(x ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function cleanPolicy(p: unknown): MetaPolicy {
  const i = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>; const o: MetaPolicy = {};
  if (i.titlePrefix !== undefined) { const v = oneLine(i.titlePrefix, 40); if (v) o.titlePrefix = v; }
  if (i.titleSuffix !== undefined) { const v = oneLine(i.titleSuffix, 40); if (v) o.titleSuffix = v; }
  if (i.addTags !== undefined) {
    if (!Array.isArray(i.addTags) || i.addTags.length > 10) throw new Error('invalid: addTags must be a list of at most 10 tags');
    const t = i.addTags.map((x) => oneLine(x, 30).replace(/^#/, '')).filter(Boolean); if (t.length) o.addTags = [...new Set(t)];
  }
  if (i.dropTags !== undefined) o.dropTags = i.dropTags === true;
  return o;
}
/** Pure: returns new facts; the input is never mutated. */
export function applyMetaPolicy(facts: ClipFacts, p: MetaPolicy, platform: string): ClipFacts {
  if (!Object.keys(p).length) return facts;
  const max = PLATFORM_CONSTRAINTS[platform]?.maxTitle ?? 100; const pre = p.titlePrefix ? p.titlePrefix + ' ' : ''; const suf = p.titleSuffix ? ' ' + p.titleSuffix : '';
  const room = Math.max(1, max - pre.length - suf.length); const base = facts.title.length > room ? facts.title.slice(0, room - 1).trimEnd() + '…' : facts.title;
  const title = (pre + base + suf).slice(0, max);
  let tags = p.dropTags ? [] : [...(facts.tags ?? [])]; for (const t of p.addTags ?? []) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  return { ...facts, title, tags };
}
