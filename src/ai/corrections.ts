import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cue } from '../analysis/transcript.ts';

/**
 * Post-recognition correction layer for Hinglish/Hindi captions. Speech models (and chat-style typing) spell the same word many ways;
 * this maps the common SMS/chat spellings to one standard form, and the owner can add their own fixes (names, brands, recurring
 * mis-hearings) in `<data>/corrections.json` as {"wrong":"right"} - whole words only, case-insensitive, the right form is used as written.
 * It never rewrites sentences: only exact whole-word replacements.
 */
export const BUILTIN: Record<string, string> = {
  nhi: 'nahi', nai: 'nahi', nahin: 'nahi', nahee: 'nahi', nehi: 'nahi', bhot: 'bahut', bohot: 'bahut', bahot: 'bahut', boht: 'bahut', mje: 'mujhe', muje: 'mujhe', mujhko: 'mujhe',
  tmhe: 'tumhe', tumko: 'tumhe', kya: 'kya', kyaa: 'kya', kyu: 'kyun', kyon: 'kyun', kyoon: 'kyun', kyunki: 'kyunki', kyonki: 'kyunki', acha: 'achha', accha: 'achha', achchha: 'achha',
  abhi: 'abhi', abi: 'abhi', jyada: 'zyada', jada: 'zyada', zyda: 'zyada', ek: 'ek', yaar: 'yaar', yar: 'yaar', dosto: 'dosto', dostoon: 'dosto', bhaiya: 'bhaiya', bhai: 'bhai', bhaee: 'bhai',
  krna: 'karna', krta: 'karta', krte: 'karte', kre: 'kare', kro: 'karo', kr: 'kar', hm: 'hum', hmm: 'hum', mera: 'mera', pta: 'pata', pata: 'pata', btao: 'batao', btana: 'batana',
  vedio: 'video', vidio: 'video', videos: 'videos', chanel: 'channel', channal: 'channel', subscibe: 'subscribe', subcribe: 'subscribe', shere: 'share', plz: 'please', pls: 'please',
};
export function loadCorrections(dataDir: string): Record<string, string> {
  const f = join(dataDir, 'corrections.json'); let own: Record<string, string> = {};
  if (existsSync(f)) { try { const j = JSON.parse(readFileSync(f, 'utf8')) as unknown; if (j && typeof j === 'object') own = Object.fromEntries(Object.entries(j as Record<string, unknown>).filter(([k, v]) => typeof v === 'string' && k.trim()).map(([k, v]) => [k.trim().toLowerCase(), String(v)])); } catch { /* a broken file never breaks rendering */ } }
  return { ...BUILTIN, ...own };
}
const WORD = /[\p{L}\p{M}\p{N}_']+/gu;
export function correctText(text: string, map: Record<string, string>): string {
  return text.replace(WORD, (w) => { const r = map[w.toLowerCase()]; if (r === undefined || r === w) return w; return w[0] === w[0]!.toUpperCase() && w[0] !== w[0]!.toLowerCase() ? r[0]!.toUpperCase() + r.slice(1) : r; });
}
export function correctCues(cues: Cue[], map: Record<string, string>): Cue[] {
  return cues.map((c) => ({ ...c, text: correctText(c.text, map), ...(c.words ? { words: c.words.map((w) => ({ ...w, text: correctText(w.text, map) })) } : {}) }));
}
