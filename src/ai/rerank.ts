import type { Candidate } from '../analysis/select.ts';
import type { AiCreds } from './settings.ts';

/**
 * Optional LLM re-ranking. The model never invents timestamps: it only SCORES the candidates our own signal analysis already cut
 * (lesson from reviewing autoshorts, where asking an LLM for timestamps goes wrong). Final score = 0.7*local + 0.3*LLM(0-10 -> 0..1).
 * Any failure on every provider in the chain returns the candidates unchanged.
 */
export async function rerankCandidates(cands: Candidate[], chain: AiCreds[], fetchFn: typeof fetch = fetch): Promise<{ cands: Candidate[]; used: string | null; note?: string }> {
  const withText = cands.filter((c) => c.transcript && c.transcript.split(/\s+/).length >= 8);
  if (!chain.length || withText.length < 2) return { cands, used: null };
  const list = cands.map((c, i) => ({ id: i, text: c.transcript.slice(0, 420) })).filter((x) => x.text.split(/\s+/).length >= 8);
  const prompt = `You judge short-video clips for viewer retention. Score each clip 0-10 (hook strength, self-contained story, emotion/value, clean ending). Use ONLY the text. Return ONLY JSON: {"scores":[{"id":number,"score":number,"why":"<=12 words"}]}\nClips:\n${JSON.stringify(list)}`;
  let lastErr = '';
  for (const env of chain) {
    try {
      const res = await fetchFn(`${env.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) }, body: JSON.stringify({ model: env.model, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '';
      const m = /\{[\s\S]*\}/.exec(content); if (!m) throw new Error('no JSON');
      const sc = (JSON.parse(m[0]) as { scores?: { id?: number; score?: number; why?: string }[] }).scores ?? [];
      const by = new Map<number, { score: number; why: string }>();
      for (const x of sc) if (Number.isInteger(x.id) && typeof x.score === 'number' && x.score >= 0 && x.score <= 10) by.set(x.id!, { score: x.score, why: String(x.why ?? '').slice(0, 90) });
      if (!by.size) throw new Error('no valid scores');
      const out = cands.map((c, i) => { const s = by.get(i); if (!s) return c; return { ...c, score: +Math.min(1, 0.7 * c.score + 0.3 * (s.score / 10)).toFixed(4), reason: `${c.reason}; AI ${s.score}/10${s.why ? ': ' + s.why : ''}`, signals: { ...c.signals, llm: s.score } }; });
      return { cands: out.sort((a, b) => b.score - a.score), used: `${env.baseUrl} ${env.model}` };
    } catch (e) { lastErr = `${env.baseUrl}: ${(e as Error).message.slice(0, 60)}`; }
  }
  return { cands, used: null, note: `llm rerank skipped (${lastErr})` };
}
