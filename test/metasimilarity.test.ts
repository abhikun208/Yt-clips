import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMetadata, lessSimilarTitle, titleSimilarity, descriptionSimilarity } from '../src/seo/metasimilarity.ts';

const others = [{ id: 1, title: 'Insane clutch 1v4 #Shorts', description: 'He clutches a 1v4 in the final round of the match and the whole lobby goes quiet right after.' }];

test('near-duplicate title is flagged, numbered template counts as same', () => {
  assert.ok(titleSimilarity('INSANE clutch 1v4!!', others[0]!.title) >= 0.8);
  assert.ok(titleSimilarity('Best play 3', 'Best play 7 #Shorts') >= 0.8);
  assert.ok(checkMetadata({ title: 'Insane clutch 1v4', description: 'x' }, others).flags.includes('near_duplicate_title'));
});
test('different title and description are not flagged', () => {
  const c = checkMetadata({ title: 'Why the drone never lands', description: 'Totally different words about drones and weather forecasts today.' }, others);
  assert.deepEqual(c.flags, []);
});
test('copied description is flagged', () => {
  assert.ok(descriptionSimilarity(others[0]!.description, others[0]!.description + ' Subscribe!') >= 0.7);
  assert.ok(checkMetadata({ title: 'Something else entirely', description: others[0]!.description }, others).flags.includes('similar_description'));
});
test('lessSimilarTitle picks a clearly better one or null', () => {
  assert.equal(lessSimilarTitle('Insane clutch 1v4', ['Insane clutch 1v4!', 'The round nobody believed'], others), 'The round nobody believed');
  assert.equal(lessSimilarTitle('Insane clutch 1v4', ['Insane clutch 1v4!!'], others), null);
  assert.equal(checkMetadata({ title: 'a', description: 'b' }, []).titleWith, null);
});
