// Hook/emotion lexicon (Hindi in Devanagari + Hinglish + English). Used as ONE signal among several, never alone.
export const HOOK_WORDS = ['secret', 'shocking', 'truth', 'never', 'biggest', 'warning', 'mistake', 'unbelievable', 'raaz', 'raz', 'sach', 'sachai', 'khulasa', 'kaise', 'kabhi nahi', 'sabse', 'dhyan', 'rahasya', 'सच', 'राज़', 'राज', 'रहस्य', 'खुलासा', 'कैसे', 'सबसे', 'कभी नहीं', 'चौंक', 'हैरान'];
export const EMOTION: Record<string, string[]> = {
  funny: ['haha', 'hahaha', 'lol', 'funny', 'mazak', 'hasi', 'हंस', 'मज़ाक', 'मजाक'],
  sad: ['sad', 'cry', 'rona', 'dukh', 'miss you', 'दुख', 'रो', 'आंसू'],
  happy: ['happy', 'khush', 'love', 'pyar', 'congratulations', 'खुश', 'प्यार', 'बधाई'],
  shock: ['wow', 'omg', 'what', 'unbelievable', 'shock', 'अरे', 'क्या', 'हैरान'],
  aggressive: ['angry', 'gussa', 'fight', 'ladai', 'गुस्सा', 'लड़ाई'],
  cute: ['cute', 'pyara', 'adorable', 'baby', 'प्यारा', 'क्यूट'],
};
export const NEGATIVE_FILLER = ['subscribe', 'like share', 'sponsor', 'link in description', 'bell icon', 'सब्सक्राइब'];

export function scoreText(t: string): { hook: number; emotion: string | null; filler: number } {
  const l = t.toLowerCase();
  if (!l.trim()) return { hook: 0, emotion: null, filler: 0 };
  const hook = Math.min(1, HOOK_WORDS.filter((w) => l.includes(w)).length / 2);
  let best: string | null = null; let bestN = 0;
  for (const [k, ws] of Object.entries(EMOTION)) { const n = ws.filter((w) => l.includes(w)).length; if (n > bestN) { best = k; bestN = n; } }
  const filler = Math.min(1, NEGATIVE_FILLER.filter((w) => l.includes(w)).length);
  return { hook, emotion: best, filler };
}
