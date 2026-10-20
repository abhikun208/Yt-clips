import type { Cue } from '../analysis/transcript.ts';

const hms = (t: number) => {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const esc = (s: string) => s.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');

export interface AssOpts { width: number; height: number; font: string; highlight: string; wordsPerChunk: number }

/**
 * Build ASS captions from cues (times relative to clip start). Word timing is APPROXIMATED by splitting each cue's
 * duration proportionally to word length (documented limitation: not true forced alignment). Each chunk pops in
 * with a scale animation and the active word is highlighted.
 */
export function buildAss(cues: Cue[], clipStart: number, clipEnd: number, title: string | null, o: AssOpts): string {
  const marginV = Math.round(o.height * 0.22);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${o.width}
PlayResY: ${o.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${o.font},${Math.round(o.height * 0.042)},&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(o.height * 0.004))},2,2,60,60,${marginV},1
Style: Title,${o.font},${Math.round(o.height * 0.038)},&H0000F0FF,&H0000FFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(o.height * 0.004))},3,8,60,60,${Math.round(o.height * 0.09)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  if (title) lines.push(`Dialogue: 1,${hms(0.2)},${hms(Math.min(3.5, clipEnd - clipStart))},Title,,0,0,0,,{\\fad(200,300)\\fscx80\\fscy80\\t(0,200,\\fscx100\\fscy100)}${esc(title)}`);
  for (const c of cues) {
    const s = Math.max(c.start, clipStart) - clipStart; const e = Math.min(c.end, clipEnd) - clipStart;
    if (e <= s) continue;
    const words = esc(c.text).split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const totalLen = words.reduce((a, w) => a + w.length + 1, 0);
    let t = s;
    const timed = words.map((w) => { const d = ((w.length + 1) / totalLen) * (e - s); const r = { w, a: t, b: t + d }; t += d; return r; });
    for (let i = 0; i < timed.length; i += o.wordsPerChunk) {
      const chunk = timed.slice(i, i + o.wordsPerChunk);
      for (let k = 0; k < chunk.length; k++) {
        const cs = chunk[k]!.a; const ce = k + 1 < chunk.length ? chunk[k + 1]!.a : chunk[k]!.b;
        const text = chunk.map((x, j) => (j === k ? `{\\c${o.highlight}\\fscx112\\fscy112}${x.w}{\\r}` : x.w)).join(' ');
        lines.push(`Dialogue: 0,${hms(cs)},${hms(Math.max(ce, cs + 0.05))},Cap,,0,0,0,,{\\fad(40,0)}${text}`);
      }
    }
  }
  return head + lines.join('\n') + '\n';
}
