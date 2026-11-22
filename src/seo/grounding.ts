/**
 * "Never invent facts": a generated title may only contain numbers and capitalised names that exist in the clip's own transcript or the
 * source title. Returns the claims that cannot be found. Pure; used to prefer a grounded alternative title and to warn otherwise.
 */
const STOP = new Set(['the', 'this', 'that', 'what', 'when', 'why', 'how', 'who', 'you', 'your', 'shorts', 'short', 'live', 'new', 'best', 'top', 'full', 'part', 'ye', 'yeh', 'woh', 'kya', 'kaise', 'kyun']);
const norm = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}%.\s]/gu, ' ');
export function ungroundedClaims(title: string, ...evidence: (string | null | undefined)[]): string[] {
  const ev = norm(evidence.filter(Boolean).join(' ')); if (!ev.trim()) return []; // nothing to check against (no transcript): never block
  const out: string[] = []; const t = title.replace(/#\w+/g, ' ');
  for (const n of t.match(/\d[\d,.]*%?/g) ?? []) { const d = n.replace(/[,.]+$/, '').replace(/,/g, ''); if (d && !ev.replace(/,/g, '').includes(d.toLocaleLowerCase())) out.push(n); }
  const words = t.split(/\s+/).filter(Boolean);
  words.forEach((w, i) => { const c = w.replace(/[^\p{L}\p{N}]/gu, ''); if (i === 0 || c.length < 3 || STOP.has(c.toLocaleLowerCase()) || c !== c[0]!.toLocaleUpperCase() + c.slice(1).toLocaleLowerCase() || c === c.toLocaleUpperCase() || /^\d/.test(c)) return; if (!ev.includes(c.toLocaleLowerCase())) out.push(c); });
  return [...new Set(out)];
}
