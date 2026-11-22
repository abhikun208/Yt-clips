import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResearch } from '../src/seo/evidence.ts';

const by = (r: ReturnType<typeof buildResearch>, t: string) => r.find((x) => x.topic === t)!;
test('real fetched data is VERIFIED_DATA, own rules ESTIMATE, model text AI_GUESS, missing UNAVAILABLE', () => {
  const r = buildResearch({ keywords: ['clutch'], suggestions: ['clutch 1v4 bgmi'], trendsTried: true, trends: ['Headline'], generatedBy: 'groq/llama', seoScore: 80 });
  assert.equal(by(r, 'keywords').label, 'ESTIMATE'); assert.equal(by(r, 'search_suggestions').label, 'VERIFIED_DATA'); assert.equal(by(r, 'trends').label, 'VERIFIED_DATA');
  assert.equal(by(r, 'title_text').label, 'AI_GUESS'); assert.equal(by(r, 'seo_score').label, 'ESTIMATE');
});
test('nothing fetched => UNAVAILABLE with an honest reason; rule text is not called AI', () => {
  const r = buildResearch({ keywords: [], suggestions: [], trendsTried: false, trends: [], generatedBy: 'rules (no AI answered)' });
  assert.equal(by(r, 'keywords').label, 'UNAVAILABLE'); assert.equal(by(r, 'search_suggestions').label, 'UNAVAILABLE'); assert.match(by(r, 'trends').detail, /not fetched/);
  assert.equal(by(r, 'title_text').label, 'ESTIMATE'); assert.equal(by(r, 'seo_score').label, 'UNAVAILABLE');
  assert.equal(buildResearch({ keywords: ['a'], suggestions: [], trendsTried: true, trends: [], generatedBy: 'FALLBACK (rules, not AI): x' }).find((x) => x.topic === 'title_text')!.label, 'ESTIMATE');
});
