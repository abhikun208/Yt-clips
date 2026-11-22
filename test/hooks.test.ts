import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { ingestLocal } from '../src/sources/local.ts';
import { analyzeVideo } from '../src/analysis/analyzer.ts';
import { hookCandidates } from '../src/seo/hooks.ts';
import type { Sentence } from '../src/analysis/textsignals.ts';
import { testConfig, tmpDir, makeFixture } from './helpers.ts';

const S = (...t: string[]): Sentence[] => t.map((text, i) => ({ start: i * 3, end: i * 3 + 2.5, text }));
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const clip = S('So yeah we were just playing around.', 'Then the lobby got really quiet for a while.', 'Wait, how did he survive three grenades in a row?', 'Nobody expected that last second clutch, honestly.', 'He had only 12 health left and still won the round.', 'The whole squad started screaming.', 'That is the best play of the season.');

test('hooks: >=5 candidates, EVERY one is verbatim from the clip, scored, best has a question/claim/number shape', () => {
  const r = hookCandidates(clip); const all = norm(clip.map((s) => s.text).join(' ')); assert.ok(r.candidates.length >= 5, `got ${r.candidates.length}`);
  for (const c of r.candidates) { assert.ok(all.includes(norm(c.text)), `not verbatim: ${c.text}`); assert.ok(c.score >= 0); assert.ok(c.reasons.length >= 0); }
  assert.match(r.best!.text, /survive three grenades|12 health|clutch/i); assert.equal(r.best, r.candidates[0]); assert.deepEqual([...r.candidates].map((c) => c.score), [...r.candidates].map((c) => c.score).sort((a, b) => b - a));
  assert.equal(new Set(r.candidates.map((c) => norm(c.text))).size, r.candidates.length, 'no duplicates'); assert.ok(r.candidates.every((c) => c.text.split(' ').length <= 9 + 1));
});
test('hooks: slow filler intro is flagged and a stronger later line is marked as a teaser (payoff in the first 1-2 s); nothing is reordered or invented', () => {
  const r = hookCandidates(clip); assert.equal(r.slowIntro, true); const t = r.candidates.find((c) => c.source === 'teaser'); assert.ok(t, 'teaser flagged'); assert.ok((t!.atSec ?? 0) >= 6); assert.match(t!.reasons.join(' '), /first 1-2 seconds/);
  assert.equal(r.candidates.find((c) => c.source === 'opening')?.atSec, null);
});
test('hooks: too little speech -> fewer (or zero) honest candidates, never padded with templates', () => {
  assert.deepEqual(hookCandidates([]).candidates, []); assert.match(hookCandidates([]).note, /nothing invented/);
  const r = hookCandidates(S('Okay then.', 'We go now friends of mine.')); assert.ok(r.candidates.length <= 2); assert.match(r.note, /only \d+ distinct honest hook/);
  assert.ok(!r.candidates.some((c) => /full|moment|insane clip/i.test(c.text) && !/full|moment|insane clip/i.test('Okay then. We go now friends of mine.')));
});
test('analyzer: with a transcript, candidate_hooks stores the verbatim candidates and the stored hook is one of them', { timeout: 150_000 }, async () => {
  const cfg = testConfig({ clip: { minSec: 8, maxSec: 20, targetSec: 12, maxClipsPerVideo: 0, minScore: 0.01 } } as never); const s = new Store(cfg.dbPath);
  const src = join(tmpDir(), 'h.mp4'); await makeFixture(src, 120);
  const lines = ['Welcome back everyone to the channel.', 'Wait, how did he survive three grenades in a row?', 'Nobody expected that last second clutch.', 'He had only 12 health left and still won.', 'The whole squad started screaming.', 'That is the best play of the season.'];
  const srt = Array.from({ length: 56 }, (_, i) => { const t = (n: number) => `00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; return `${i + 1}\n${t(i * 2)},000 --> ${t(i * 2 + 1)},900\n${lines[i % lines.length]}\n`; }).join('\n'); const r = await ingestLocal(s, cfg, src); writeFileSync(s.get<{ path: string }>('SELECT path FROM videos WHERE id=?', r.videoId)!.path.replace(/\.[^.]+$/, '.srt'), srt); const a = await analyzeVideo(s, cfg, r.videoId, { force: true }); assert.ok(a.candidates > 0);
  const rows = s.all<{ best: string | null; candidates_json: string; hook: string }>('SELECT h.best, h.candidates_json, c.hook FROM candidate_hooks h JOIN candidates c ON c.id=h.candidate_id WHERE c.status=\'candidate\''); assert.ok(rows.length > 0, 'hooks stored');
  const withBest = rows.filter((x) => x.best); assert.ok(withBest.length > 0); const spoken = norm(lines.join(' ')); for (const x of withBest) { assert.ok(spoken.includes(norm(x.best!)), `stored best is verbatim: ${x.best}`); assert.ok(JSON.parse(x.candidates_json).candidates.length >= 1); }
  console.log('# real stored example:', JSON.stringify({ hook: withBest[0]!.hook, best: withBest[0]!.best, n: JSON.parse(withBest[0]!.candidates_json).candidates.length }));
});
