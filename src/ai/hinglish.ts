/**
 * Rule-based Devanagari → Roman ("Hinglish") transliteration. Free, offline, deterministic, keeps word boundaries (so karaoke word
 * timing survives). Two layers:
 *   1) a dictionary of very common Hindi words/loanwords spelled the way Indians actually type them (hai, nahi, aapko, video, kaam…);
 *   2) a phonetic fallback with real schwa deletion (karta, batane, aapko), long "aa" in the first syllable (kaam, baat, saath) and
 *      short "a" elsewhere (batane, wala), "ee/oo" in the middle of a word, "i/u" at its end.
 * It is still an approximation: rare names can be spelled differently from how the owner would type them.
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

/** Common words, spelled as people type them (keys are NFC Devanagari without punctuation). */
const DICT: Record<string, string> = Object.fromEntries(`
है hai|हैं hain|हूँ hu|हूं hu|हो ho|होगा hoga|होगी hogi|होता hota|होती hoti|होते hote|हुआ hua|हुई hui|हुए hue|था tha|थी thi|थे the|रहा raha|रही rahi|रहे rahe|रहा है raha hai|गया gaya|गई gayi|गए gaye|गयी gayi|गये gaye
मैं main|में mein|मैंने maine|मुझे mujhe|मुझको mujhko|मेरा mera|मेरी meri|मेरे mere|हम hum|हमें hume|हमारा hamara|हमारी hamari|हमारे hamare|तुम tum|तुम्हें tumhe|तुम्हारा tumhara|तुम्हारी tumhari|तुम्हारे tumhare|तू tu|तेरा tera|तेरी teri|तेरे tere|आप aap|आपको aapko|आपका aapka|आपकी aapki|आपके aapke|आपने aapne
वह woh|वो wo|ये ye|यह yeh|इस is|उस us|इसे ise|उसे use|उन्हें unhe|उनको unko|उनका unka|इसका iska|उसका uska|इसलिए isliye|इसीलिए isiliye|उसने usne|उन्होंने unhone|इन्होंने inhone|वे we|वहाँ wahan|यहाँ yahan|कहाँ kahan|जहाँ jahan|कहीं kahin|वहीं wahin|यहीं yahin
और aur|या ya|कि ki|की ki|का ka|के ke|को ko|से se|पर par|पे pe|तक tak|भी bhi|ही hi|तो to|न na|ना na|नहीं nahi|मत mat|बिना bina|साथ saath|लिए liye|वाला wala|वाली wali|वाले wale|जैसा jaisa|जैसे jaise|जितना jitna|उतना utna|इतना itna|कितना kitna|कितने kitne|कितनी kitni|कैसा kaisa|कैसे kaise|कैसी kaisi|कौन kaun|क्या kya|क्यों kyun|क्योंकि kyunki|कब kab|कभी kabhi|जब jab|तब tab|अब ab|फिर phir|अभी abhi|बस bas|सिर्फ sirf|सिर्फ़ sirf|बहुत bahut|बड़ा bada|बड़ी badi|बड़े bade|छोटा chhota|छोटी chhoti|अच्छा achha|अच्छी achhi|अच्छे achhe|बुरा bura|सच sach|झूठ jhoot|ठीक theek|सही sahi|गलत galat|ग़लत galat|ज़्यादा zyada|ज्यादा zyada|कम kam|काम kaam|कुछ kuch|कोई koi|सब sab|सबको sabko|सभी sabhi|हर har|एक ek|दो do|तीन teen|चार chaar|पाँच paanch|दस das|सौ sau|हज़ार hazaar|लाख lakh|करोड़ crore|पहले pehle|बाद baad|बाद में baad mein|अगर agar|लेकिन lekin|मगर magar|पर par|क्योंकि kyunki|इसलिये isliye|जरूर zaroor|ज़रूर zaroor|ज़रूरी zaroori|जरूरी zaroori|चाहिए chahiye|चाहिये chahiye|पड़ता padta|सकता sakta|सकती sakti|सकते sakte|चाहता chahta|चाहती chahti|करना karna|करता karta|करती karti|करते karte|किया kiya|की ki|करो karo|करें karen|करेंगे karenge|करूँगा karunga|देखो dekho|देखना dekhna|देखा dekha|देखिए dekhiye|सुनो suno|सुनना sunna|बोलो bolo|बोला bola|बोली boli|बोले bole|कहा kaha|कहते kehte|कहना kehna|बताओ batao|बताया bataya|बताना batana|बताने batane|जाना jaana|जाओ jao|जाता jata|जाती jati|जाते jate|आना aana|आओ aao|आया aaya|आई aayi|आए aaye|लेना lena|लिया liya|दिया diya|देना dena|मिला mila|मिली mili|मिलकर milkar|मिल mil|लगा laga|लगता lagta|लगती lagti|लगे lage|पता pata|समझ samajh|समझा samjha|समझो samjho|मालूम maloom|याद yaad|प्यार pyaar|दोस्त dost|दोस्तों doston|दोस्ती dosti|भाई bhai|भइया bhaiya|बहन behen|माँ maa|पापा papa|बेटा beta|बेटी beti|लड़का ladka|लड़की ladki|आदमी aadmi|लोग log|लोगों logon|घर ghar|पैसा paisa|पैसे paise|रुपये rupaye|दुनिया duniya|ज़िंदगी zindagi|जिंदगी zindagi|दिन din|रात raat|आज aaj|कल kal|सुबह subah|शाम shaam|साल saal|महीना mahina|हफ्ता hafta|टाइम time|समय samay|वक़्त waqt|वक्त waqt|बात baat|बातें baatein|कहानी kahani|मज़ा maza|मजा maza|मज़ेदार mazedaar|खुश khush|दुख dukh|गुस्सा gussa|डर dar|हँसी hansi|नाम naam|जी ji|जी हाँ ji haan|हाँ haan|हां haan|नहीं nahi|अरे are|अरे यार arre yaar|यार yaar|चलो chalo|चल chal|ठहरो ruko|रुको ruko|जल्दी jaldi|धीरे dheere|सीधा seedha|आसान aasan|मुश्किल mushkil|मुश्किल mushkil|खास khaas|पूरा poora|पूरी poori|पूरे poore|आधा aadha|अपना apna|अपनी apni|अपने apne|खुद khud|दूसरा doosra|दूसरे doosre|पहला pehla|पहली pehli|आखिरी aakhri|आख़िरी aakhri|सबसे sabse|बाकी baaki|बाकि baaki|मतलब matlab|वैसे waise|ऐसे aise|ऐसा aisa|ऐसी aisi|वैसा waisa|उधर udhar|इधर idhar|ऊपर upar|नीचे neeche|अंदर andar|बाहर bahar|आगे aage|पीछे peeche|सामने saamne
आएगा aayega|जाएगा jayega|होगा hoga|बबीता babita|जेठालाल jethalal|तारक taarak|टप्पू tappu|भिड़े bhide|दयाबेन dayaben|रास्ता rasta|वीडियो video|वीडिओ video|चैनल channel|सब्सक्राइब subscribe|लाइक like|शेयर share|कमेंट comment|कमेन्ट comment|फ़ोन phone|फोन phone|मोबाइल mobile|इंटरनेट internet|ऐप app|ऐप्प app|गेम game|गेमिंग gaming|प्लेयर player|टीम team|मैच match|लाइव live|स्टार star|हीरो hero|फिल्म film|फ़िल्म film|सीरियल serial|शो show|एपिसोड episode|सीजन season|बिज़नेस business|बिजनेस business|ऑनलाइन online|ऑफलाइन offline|मनी money|पावर power|लेवल level|टिप्स tips|ट्रिक trick|ट्रिक्स tricks|आइडिया idea|प्लान plan|प्रोजेक्ट project|कंटेंट content|क्रिएटर creator|यूट्यूब youtube|यूट्यूबर youtuber|इंस्टाग्राम instagram|फेसबुक facebook|व्हाट्सएप whatsapp|गूगल google|एआई ai|सॉरी sorry|थैंक्यू thankyou|प्लीज़ please|प्लीज please|ओके ok|हेलो hello|हाय hi|बाय bye|गुड good|बेस्ट best|फुल full|फ्री free|नया naya|नई nayi|नये naye|नए naye|पुराना purana
`.split(/\n|\|/).map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.lastIndexOf(' '); return [x.slice(0, i).trim().normalize('NFC'), x.slice(i + 1)] as [string, string]; }).filter(([k, v]) => k && v && !k.includes(' ')));

const isCons = (c?: string) => !!c && !!CONS[c];
interface Unit { pre: string; v: string | null; /** v === null: inherent 'a' */ end?: boolean }

function phonetic(w: string): string {
  const ch = [...w.normalize('NFC')];
  // build syllable units: consonant cluster + vowel
  const units: { cons: string; vowel: string | 'inh' | 'none' }[] = []; let cur = '';
  for (let i = 0; i < ch.length; i++) {
    let c = ch[i]!;
    if (ch[i + 1] === '़' && CONS[c + '़']) { c = c + '़'; i++; }
    if (CONS[c]) {
      cur += CONS[c]; const nx = ch[i + 1];
      if (nx === '्') { i++; continue; }                          // halant: cluster continues
      if (nx && MATRA[nx]) { units.push({ cons: cur, vowel: nx }); cur = ''; i++; continue; }
      units.push({ cons: cur, vowel: 'inh' }); cur = '';
    } else if (IND[c]) { if (cur) { units.push({ cons: cur, vowel: 'inh' }); cur = ''; } units.push({ cons: '', vowel: c }); }
    else if (c === 'ं' || c === 'ँ') { if (cur) { units.push({ cons: cur, vowel: 'inh' }); cur = ''; } units.push({ cons: c === 'ं' ? '#n' : '#n', vowel: 'none' }); }
    else if (c === 'ः') { units.push({ cons: 'h', vowel: 'none' }); }
    else if (DIGITS[c]) { units.push({ cons: DIGITS[c]!, vowel: 'none' }); }
    else if (c === '।') units.push({ cons: '.', vowel: 'none' });
    else if (c !== '़' && c !== '्' && c !== '‌' && c !== '‍') units.push({ cons: c, vowel: 'none' });
  }
  if (cur) units.push({ cons: cur, vowel: 'inh' });
  // schwa deletion: word-final, then medial (right to left): delete if not the first syllable and the next unit keeps its vowel
  const real = units.map((u, i) => ({ u, i })).filter((x) => x.u.vowel !== 'none');
  const keep = new Set<number>(); for (const { u, i } of real) if (u.vowel === 'inh') keep.add(i);
  const last = real.at(-1);
  if (last && last.u.vowel === 'inh') keep.delete(last.i);
  for (let k = real.length - 2; k >= 1; k--) { const { u, i } = real[k]!; if (u.vowel !== 'inh') continue; const nx = real[k + 1]!; const nxKept = nx.u.vowel !== 'inh' || keep.has(nx.i); const prevOpen = real[k - 1]!.u.vowel !== 'inh' || keep.has(real[k - 1]!.i); if (nxKept && prevOpen) keep.delete(i); }
  let out = ''; let syl = 0;
  const nUnits = real.length;
  units.forEach((u, i) => {
    if (u.vowel === 'none') { out += u.cons === '#n' ? '#n' : u.cons; return; }
    const first = syl === 0, atEnd = i === units.findLastIndex((x) => x.vowel !== 'none');
    syl++; out += u.cons;
    if (u.vowel === 'inh') { if (keep.has(i)) out += 'a'; return; }
    if (u.vowel === 'ा') { out += atEnd ? 'a' : first || nUnits === 2 && real[0]!.i === i ? 'aa' : 'a'; return; }
    if (u.vowel === 'ी') { out += !atEnd && first ? 'ee' : 'i'; return; }
    if (u.vowel === 'ू') { out += !atEnd && first ? 'oo' : 'u'; return; }
    if (MATRA[u.vowel]) { out += MATRA[u.vowel]; return; }
    const v = IND[u.vowel]!; out += atEnd && v === 'aa' ? 'a' : atEnd && v === 'ee' ? 'i' : atEnd && v === 'oo' ? 'u' : v;
  });
  // anusvara / chandrabindu: m before p/b/m, else n
  out = out.replace(/#n(?=[pbm])/g, 'm').replace(/#n/g, 'n');
  return out.replace(/aaa+/g, 'aa').replace(/ii+$/, 'i');
}

function word(w: string): string {
  const n = w.normalize('NFC').replace(/[‌‍]/g, ''); const hit = DICT[n]; if (hit) return hit;
  return phonetic(n);
}
const TOKEN = /[ऀ-ॿ‌‍]+/g;
export function toHinglish(text: string): string { return hasDevanagari(text) ? text.replace(TOKEN, (m) => word(m)).replace(/।/g, '.').replace(/\s+/g, ' ').trim() : text; }

const CYR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
/** Letters of a script that is neither Latin nor Devanagari (Cyrillic, Arabic/Urdu, CJK ...): speech models sometimes leak them into a Hindi transcript ("vЕЛЕЙmi" in the owner's caption). Cyrillic is transliterated, any other foreign script is removed and COUNTED so the caller can report it (never silent). Devanagari is left to toHinglish. */
export function stripForeignScripts(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(/[\u0400-\u04FF]/g, (c) => { const l = CYR[c.toLowerCase()]; if (l === undefined) { removed++; return ''; } return c === c.toLowerCase() ? l : l.toUpperCase(); })
    .replace(/[\u0590-\u08FF\u0980-\u1FFF\u2E80-\uD7FF\uF900-\uFDFF\uFE70-\uFEFF\uFF66-\uFFDC]/g, (c) => { if (/[\u0900-\u097F]/.test(c)) return c; removed++; return ''; });
  return { text: out.replace(/\s{2,}/g, ' ').trim(), removed };
}
