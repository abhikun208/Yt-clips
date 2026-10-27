import { splitSentences } from './local.ts';
import { hookScore } from '../analysis/textsignals.ts';

/**
 * On-screen hook line: a SHORT sentence the clip really contains (never a template like "Full Josh Wala Moment").
 * Returns null when the clip has too little speech to pick one honestly, so nothing is burned into the video.
 */
export function realHook(transcript: string, preferred?: string): string | null {
  const text = (transcript ?? '').replace(/\s+/g, ' ').trim(); if (text.split(' ').filter(Boolean).length < 6) return null;
  const sents = splitSentences(text).filter((s) => s.split(' ').length >= 3);
  const pool = [preferred, ...sents.slice(0, 4)].filter((x): x is string => !!x && x.trim().length > 0);
  const best = pool.map((s) => ({ s, v: hookScore(s) + (s.length <= 60 ? 0.2 : 0) })).sort((a, b) => b.v - a.v)[0]?.s; if (!best) return null;
  const clean = best.replace(/[#@]\S+/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
  const words = clean.split(' '); const out = words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
  return out.length >= 8 ? out.slice(0, 56) : null;
}
