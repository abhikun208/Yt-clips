/**
 * Rule-based Devanagari → Roman ("Hinglish") transliteration. Free, offline, deterministic: used when the captions came out in
 * Devanagari and the channel wants Hinglish (Hindi written in Latin letters, the way Indians type). It is a phonetic approximation
 * (final schwa dropped, nasal marks simplified), not a dictionary; an LLM translation, when configured, reads better.
 */
const IND: Record<string, string> = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e' };
const MATRA: Record<string, string> = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const CONS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'f', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'य़': 'y', 'ळ': 'l',
};
const DIGITS: Record<string, string> = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
export const hasDevanagari = (s: string): boolean => /[ऀ-ॿ]/.test(s);

function word(w: string): string {
  const ch = [...w.normalize('NFC')]; let out = '';
  for (let i = 0; i < ch.length; i++) {
    let c = ch[i]!; const nx = ch[i + 1];
    if (nx === '़' && CONS[c + nx]) { c = c + nx; i++; }
    const nx2 = ch[i + 1];
    if (CONS[c]) {
      out += CONS[c];
      if (nx2 === '्') { i++; continue; }                       // halant: no vowel
      if (nx2 && MATRA[nx2]) { out += MATRA[nx2]; i++; continue; }
      const more = ch.slice(i + 1).some((x) => CONS[x] || IND[x]);   // inherent 'a' — dropped at the end of a word
      if (more) out += 'a';
    } else if (IND[c]) out += IND[c];
    else if (c === 'ं' || c === 'ँ') out += 'n';            // anusvara / chandrabindu
    else if (c === 'ः') out += 'h';
    else if (DIGITS[c]) out += DIGITS[c];
    else if (c === '़' || c === '्') continue;
    else if (c === '।') out += '.';
    else out += c;
  }
  // light cleanup of very common Hindi function words (spelling people actually type)
  const FIX: Record<string, string> = { 'hain': 'hai', 'hoon': 'hu', 'mein': 'mein', 'nahin': 'nahi', 'naheen': 'nahi', 'rahaa': 'raha', 'kyaa': 'kya', 'yaha': 'yahan', 'wahaan': 'wahan' };
  out = out.replace(/(?<!^)aa/g, 'a').replace(/ee$/, 'i').replace(/aee/g, 'ai').replace(/oo$/, 'u');
  return FIX[out] ?? out;
}
export function toHinglish(text: string): string { return hasDevanagari(text) ? text.replace(/[ऀ-ॿ‌‍]+/g, (m) => word(m)).replace(/\s+/g, ' ').trim() : text; }
