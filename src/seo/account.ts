import type { Store } from '../db.ts';
import type { Channel } from '../channels.ts';
import { keyphrases } from './local.ts';

/**
 * Account optimizer: a ready-to-apply "profile kit" for one channel, built ONLY from what the owner configured (name, language, links,
 * hashtags, schedule) and from what the channel's own clips really talk about (top keyphrases from their transcripts).
 * Nothing is invented: no subscriber counts, no "daily uploads" unless the schedule says so, no links the owner did not configure.
 */
export interface AccountKit {
  channel: string; lang: 'hinglish' | 'hi' | 'en'; topics: string[]; description: string; keywords: string; defaultTags: string[]; bio: string;
  playlists: { title: string; description: string }[]; pinnedComment: string; checklist: { item: string; ok: boolean; hint: string }[]; generatedAt: string;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function topicsOfChannel(store: Store, ch: Channel, n = 8): string[] {
  const rows = store.all<{ transcript: string | null }>(`SELECT c.transcript FROM candidates c JOIN videos v ON v.id=c.video_id JOIN sources s ON s.id=v.source_id WHERE c.transcript IS NOT NULL AND c.transcript<>'' AND COALESCE(s.channel_id, 1)=? ORDER BY c.score DESC LIMIT 60`, ch.id);
  const text = rows.map((r) => r.transcript).join('. '); return text.length < 40 ? [] : keyphrases(text, n).map((k) => k.phrase);
}

export function buildAccountKit(store: Store, ch: Channel, o: { youtube?: { description: string; keywords: string } | null } = {}): AccountKit {
  const lang: AccountKit['lang'] = ch.config.language === 'hi' ? 'hinglish' : ch.config.language === 'en' ? 'en' : 'hinglish';
  const topics = topicsOfChannel(store, ch); const gaming = ch.profile === 'gaming'; const niche = gaming ? 'Free Fire / gaming' : 'best moments';
  const tags = (ch.config.hashtags ?? []).map((h) => h.replace(/^#/, ''));
  const perDay = ch.config.schedule?.perDayCap; const links = ch.config.links ?? [];
  const H = lang === 'en'
    ? { l1: `${ch.name} — ${niche} clips, highlights and shorts.`, l2: topics.length ? `Topics: ${topics.slice(0, 5).join(', ')}.` : '', l3: perDay ? `New shorts posted regularly (up to ${perDay}/day).` : 'New shorts posted regularly.', cta: 'Subscribe and turn on the bell so you never miss a moment.', pin: 'Which moment was your favourite? Tell us below 👇', pl: (t: string) => `Best ${t} moments` }
    : { l1: `${ch.name} — ${gaming ? 'Free Fire / gaming ke best clips, highlights aur shorts' : 'best moments, clips aur shorts'}.`, l2: topics.length ? `Topics: ${topics.slice(0, 5).join(', ')}.` : '', l3: perDay ? `Naye shorts regular aate hain (roz ${perDay} tak).` : 'Naye shorts regular aate hain.', cta: 'Subscribe karo aur bell icon dabao taaki koi moment miss na ho.', pin: 'Aapko kaunsa moment sabse zyada pasand aaya? Neeche comment karo 👇', pl: (t: string) => `Best ${t} moments` };
  const linkLines = links.map((l) => `${l.label}: ${l.url}`);
  const description = [H.l1, H.l2, H.l3, '', H.cta, ...(linkLines.length ? ['', ...linkLines] : [])].filter((x, i, a) => !(x === '' && (i === 0 || a[i - 1] === ''))).join('\n').trim().slice(0, 1000);
  const kwBase = [...topics, ...tags, ch.name, ...(gaming ? ['free fire', 'gaming shorts', 'highlights'] : ['shorts', 'best moments'])].filter((x, i, a) => x && a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  let keywords = ''; for (const k of kwBase) { const q = /\s/.test(k) ? `"${k}"` : k; if ((keywords + ' ' + q).trim().length > 480) break; keywords = (keywords + ' ' + q).trim(); }
  const bio = [`${ch.name} | ${gaming ? 'Free Fire clips' : 'Best moments'}`, tags.length ? tags.slice(0, 3).map((t) => '#' + t).join(' ') : '', 'Follow for daily shorts'.replace('daily', perDay ? 'regular' : 'regular')].filter(Boolean).join(' · ').slice(0, 150);
  const playlists = topics.slice(0, 4).map((t) => ({ title: cap(H.pl(t)).slice(0, 100), description: `${ch.name}: ${t} se jude best shorts.`.slice(0, 300) }));
  if (!playlists.length) playlists.push({ title: `${ch.name} — Best Shorts`, description: `${ch.name} ke best shorts ek jagah.` });
  const pinnedComment = [H.pin, ...(linkLines.length ? ['', ...linkLines.slice(0, 3)] : [])].join('\n').slice(0, 500);
  const yt = o.youtube;
  const checklist = [
    { item: 'Channel description set', ok: !!yt ? yt.description.trim().length >= 100 : false, hint: 'apply the generated description' },
    { item: 'Channel keywords set', ok: !!yt ? yt.keywords.trim().length > 0 : false, hint: 'apply the generated keywords' },
    { item: 'Owner links configured', ok: links.length > 0, hint: 'add links (Instagram/Discord/etc.) in channel settings' },
    { item: 'Channel hashtags configured', ok: tags.length > 0, hint: 'add 2-3 brand hashtags in channel settings' },
    { item: 'Topics learned from clips', ok: topics.length > 0, hint: 'process some videos with captions so topics can be learned' },
    { item: 'Banner / profile photo', ok: false, hint: 'manual: upload a 2048x1152 banner and a clear logo (not automatable here)' },
  ];
  return { channel: ch.slug, lang, topics, description, keywords, defaultTags: kwBase.slice(0, 12), bio, playlists, pinnedComment, checklist, generatedAt: new Date().toISOString() };
}
