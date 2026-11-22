import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipeFor, applyRecipe, cuePlan, wantsBroll, type Cue } from '../src/styles/recipes.ts';
import { CONTENT_TYPES } from '../src/analysis/contentdetect.ts';

test('every detectable content type has a recipe; unknown/general -> null (nothing changes)', () => {
  for (const t of Object.keys(CONTENT_TYPES)) assert.ok(recipeFor(t), `recipe for ${t}`);
  assert.equal(recipeFor('general'), null); assert.equal(recipeFor(undefined), null); assert.equal(recipeFor('nonsense'), null);
});
test('suitability: podcast/story/educational get no SFX; gaming/comedy do; podcast keeps natural speech', () => {
  for (const t of ['podcast', 'story', 'educational']) { const r = recipeFor(t)!; assert.deepEqual([r.sfx.whoosh, r.sfx.pop], [[], []], t); assert.equal(r.jumpCuts, false); }
  assert.ok(recipeFor('gaming')!.sfx.pop.includes('kill')); assert.deepEqual(recipeFor('comedy')!.sfx.pop, ['punchline']); assert.equal(recipeFor('podcast')!.music.allowed, false);
});
test('sad / dialogue mood silences SFX even for gaming; the shared recipe table is not mutated', () => {
  assert.deepEqual(recipeFor('gaming', 'sad')!.sfx, { whoosh: [], pop: [] }); assert.ok(recipeFor('gaming', 'funny')!.sfx.pop.length > 0);
  const a = recipeFor('gaming')!; a.sfx.pop.push('hook'); assert.ok(!recipeFor('gaming')!.sfx.pop.includes('hook'));
});
test('applyRecipe fills only options the owner left undefined (manual settings win, including an explicit false)', () => {
  const r = recipeFor('gaming')!; const { options, filled } = applyRecipe({ zoom: false, pace: 'slow' } as Record<string, unknown>, r);
  assert.equal(options.zoom, false); assert.equal(options.pace, 'slow'); assert.ok(!filled.includes('zoom') && !filled.includes('pace')); assert.equal(options.jumpCuts, true); assert.ok(filled.includes('jumpCuts'));
});
test('cuePlan: only allowed kinds, min gap, caps (4 whoosh / 6 pop), ignores bad times', () => {
  const r = recipeFor('gaming')!; const cues: Cue[] = [{ t: 0.2, kind: 'hook' }, { t: 0.5, kind: 'kill' }, { t: 2, kind: 'kill' }, { t: 2.3, kind: 'emphasis' }, { t: 5, kind: 'punchline' }, { t: -1, kind: 'kill' }, { t: NaN, kind: 'kill' }];
  assert.deepEqual(cuePlan(r, cues), { whoosh: [0.2], pop: [2] }); // 0.5 too close to 0.2; 2.3 too close to 2; punchline not allowed for gaming
  const many = Array.from({ length: 30 }, (_, i) => ({ t: i * 2, kind: 'kill' as const })); assert.equal(cuePlan(r, many).pop.length, 6);
  assert.deepEqual(cuePlan(recipeFor('podcast')!, many), { whoosh: [], pop: [] });
});
test('B-roll: noFaceOnly means only without a face; topic always; never never', () => {
  assert.equal(wantsBroll(recipeFor('story')!, true), false); assert.equal(wantsBroll(recipeFor('story')!, false), true); assert.equal(wantsBroll(recipeFor('educational')!, true), true); assert.equal(wantsBroll(recipeFor('gaming')!, false), false);
});
