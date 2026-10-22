import type { Store } from '../db.ts';
import type { Config } from '../config.ts';

export type CommentClass = 'question' | 'praise' | 'feedback' | 'spam' | 'abuse' | 'other';
const SPAM = /(https?:\/\/|www\.|t\.me\/|whatsapp|subscribe to my|sub4sub|follow me|dm me|promo|click here|earn \$|bit\.ly)/i;
const ABUSE = /(\bmc\b|\bbc\b|madarchod|bhenchod|chutiya|harami|idiot|stupid|kill yourself|hate you)/i;
const PII = /(\b\d{10}\b|\b[\w.+-]+@[\w-]+\.[\w.]+\b)/;

export function classifyComment(t: string): CommentClass {
  if (SPAM.test(t)) return 'spam';
  if (ABUSE.test(t)) return 'abuse';
  if (/\?|kaise|kya |kab |kahan|kaun|kyu|kyun|how |what |why |when |where |\bwhich\b|\bकैसे\b|\bक्या\b/i.test(t)) return 'question';
  if (/(nice|great|awesome|love|best|amazing|mast|badhiya|zabardast|superb|❤|🔥|👏|शानदार|बढ़िया)/i.test(t)) return 'praise';
  if (t.trim().split(/\s+/).length >= 6) return 'feedback';
  return 'other';
}

/** Draft-only reply. Never fabricates facts: questions get an honest "will check" style reply, not an invented answer. */
export function draftReply(c: CommentClass, text: string, lang: 'hinglish' | 'en' = 'hinglish'): string | null {
  if (c === 'spam' || c === 'abuse' || PII.test(text)) return null; // never reply to these; flag for moderation
  const h = lang === 'hinglish';
  if (c === 'praise') return h ? 'Bahut shukriya! ❤️ Aapka support hi hamari taakat hai.' : 'Thank you so much! ❤️ Your support means a lot.';
  if (c === 'question') return h ? 'Achha sawaal hai! Hum isse dhyan mein rakh rahe hain, agle video mein detail mein cover karne ki koshish karenge. 🙏' : 'Great question! We will try to cover this in more detail in an upcoming video. 🙏';
  if (c === 'feedback') return h ? 'Aapke feedback ke liye dhanyavaad, hum ispar dhyan denge. 🙏' : 'Thanks for the feedback, we will take it into account. 🙏';
  return null;
}

export function ingestComment(store: Store, platform: string, remoteId: string, text: string): { id: number; class: CommentClass; draft: string | null; duplicate: boolean } {
  const ex = store.get<{ id: number; class: CommentClass; draft: string | null }>('SELECT id, class, draft FROM comments WHERE platform=? AND remote_id=?', platform, remoteId);
  if (ex) return { ...ex, duplicate: true };
  const cls = classifyComment(text); const draft = draftReply(cls, text);
  const status = cls === 'spam' || cls === 'abuse' ? 'flagged' : draft ? 'draft' : 'ignored';
  const r = store.exec('INSERT INTO comments(platform, remote_id, text, class, draft, status) VALUES (?,?,?,?,?,?)', platform, remoteId, text, cls, draft, status);
  return { id: r.lastId, class: cls, draft, duplicate: false };
}

/** Posting requires: gates.commentsAutoPost (owner opt-in) AND explicit per-comment approval. Default = never posts. */
export async function postApprovedReply(store: Store, cfg: Config, commentId: number, poster: (platform: string, remoteId: string, text: string) => Promise<void>): Promise<void> {
  if (!cfg.gates.commentsAutoPost) throw new Error('COMMENTS_DISABLED: gates.commentsAutoPost is false (draft/approval mode only).');
  const c = store.get<{ platform: string; remote_id: string; draft: string | null; status: string }>('SELECT platform, remote_id, draft, status FROM comments WHERE id=?', commentId);
  if (!c || !c.draft) throw new Error('No draft to post');
  if (c.status !== 'approved') throw new Error('Reply not approved by owner');
  const today = store.get<{ n: number }>(`SELECT count(*) n FROM comments WHERE status='posted' AND posted_at >= datetime('now','-1 day')`)!.n;
  if (today >= cfg.comments.maxRepliesPerDay) throw new Error(`QUOTA_EXCEEDED: ${today} replies in the last 24h (cap ${cfg.comments.maxRepliesPerDay})`);
  await poster(c.platform, c.remote_id, c.draft);
  store.exec(`UPDATE comments SET status='posted', posted_at=datetime('now') WHERE id=?`, commentId);
}

export function setCommentStatus(store: Store, id: number, action: 'approve' | 'reject' | 'edit', text?: string): void {
  const c = store.get<{ status: string; draft: string | null }>('SELECT status, draft FROM comments WHERE id=?', id); if (!c) throw new Error(`invalid: unknown comment ${id}`);
  if (c.status === 'posted') throw new Error('invalid: already posted');
  if (action === 'edit') { const t = (text ?? '').trim(); if (!t || t.length > 500) throw new Error('invalid: reply must be 1..500 chars'); if (/https?:\/\/|www\./i.test(t)) throw new Error('invalid: links are never allowed in replies'); store.exec(`UPDATE comments SET draft=?, status='draft' WHERE id=?`, t, id); return; }
  if (action === 'approve') { if (!c.draft) throw new Error('invalid: nothing to approve (no draft)'); store.exec(`UPDATE comments SET status='approved' WHERE id=?`, id); return; }
  store.exec(`UPDATE comments SET status='ignored' WHERE id=?`, id);
}
