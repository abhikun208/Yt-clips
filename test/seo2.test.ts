import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, composeDescription, mmss } from '../src/seo/brief.ts';
import { scoreMetadata } from '../src/seo/score.ts';
import { buildMetadata } from '../src/seo/metadata.ts';

const cues = Array.from({ length: 12 }, (_, i) => ({ start: 100 + i * 5, end: 100 + i * 5 + 4.5, text: `Bhai yeh clutch number ${i} bahut zabardast tha dekho` }));
const transcript = cues.map((c) => c.text).join('. ') + '.';

test('brief: chapters real, first at 0:00, ≥3, ≥10s apart; none for short clips', () => {
  const b = buildBrief({ transcript, cues, clipStart: 100, duration: 58 });
  assert.ok(b.chapters.length >= 3); assert.equal(b.chapters[0]!.t, 0);
  for (let i = 1; i < b.chapters.length; i++) assert.ok(b.chapters[i]!.t - b.chapters[i - 1]!.t >= 10);
  assert.equal(buildBrief({ transcript, cues, clipStart: 100, duration: 20 }).chapters.length, 0);
  assert.equal(mmss(75), '1:15');
});
test('buildMetadata: structured description + score + part line', () => {
  const m = buildMetadata({ transcript, category: 'high_energy', language: 'hinglish', cues, clipStart: 100, duration: 58, part: { no: 2, total: 3 }, sourceTitle: 'Live Stream', channelName: 'Team X' });
  assert.match(m.description, /Part 2\/3/); assert.match(m.description, /Time map/); assert.match(m.description, /Search karo/); assert.match(m.description, /#Shorts/);
  assert.ok(m.seo && m.seo.seo > 0 && m.seo.ctr > 0 && typeof m.seo.note === 'string');
  assert.ok(m.description.length <= 4900);
});
test('score flags weak metadata', () => {
  const s = scoreMetadata({ titles: ['a'], title: 'x #Shorts', description: '#a', tags: [], hashtags: [], keywords: ['clutch'], language: 'en', thumbnailText: 'this is far too many words here', source: 'template', warnings: [] });
  assert.ok(s.issues.length >= 5 && s.ctr < 40);
});
test('composeDescription never invents links', () => {
  const d = composeDescription({ about: 'x', highlights: [], chapters: [], searches: [], related: [], hashtags: ['#Shorts'], lang: 'en' });
  assert.ok(!/https?:/.test(d));
});
import { fitCaption } from '../src/seo/brief.ts';
test('fitCaption keeps hashtags and the limit', () => {
  const d = ['about line', '⏱ Time map\n0:00 a\n0:12 b\n0:25 c', '🔥 Related: x', 'Poori video: V', '#Shorts #A'].join('\n\n') + 'z'.repeat(0);
  const out = fitCaption('Title', d + '\n\n' + 'x'.repeat(2000), 300); assert.ok(out.length <= 300);
  const out2 = fitCaption('Title', d, 120); assert.ok(out2.length <= 120 && out2.includes('#Shorts'));
});
