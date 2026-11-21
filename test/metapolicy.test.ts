import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { createChannel } from '../src/channels.ts';
import { setSourceMapping, listSourceMappings } from '../src/accounts/destinations.ts';
import { applyMetaPolicy, cleanPolicy, getMetaPolicy, setMetaPolicy } from '../src/accounts/metapolicy.ts';
import type { ClipFacts } from '../src/publish/machine.ts';

const facts = (over: Partial<ClipFacts> = {}): ClipFacts => ({ width: 1080, height: 1920, duration: 30, title: 'Real title one', description: 'd', qcPass: true, authorized: true, tags: ['Gaming', 'funny'], ...over });

test('policy: prefix/suffix + extra tags (deduped, case-insensitive); input facts never mutated', () => {
  const f = facts(); const out = applyMetaPolicy(f, { titlePrefix: '🔥', titleSuffix: '| Hindi', addTags: ['gaming', 'clips'] }, 'youtube_shorts');
  assert.equal(out.title, '🔥 Real title one | Hindi'); assert.deepEqual(out.tags, ['Gaming', 'funny', 'clips']); assert.equal(f.title, 'Real title one'); assert.deepEqual(f.tags, ['Gaming', 'funny']);
});
test('policy: dropTags removes the clip tags; empty policy returns the same facts', () => {
  assert.deepEqual(applyMetaPolicy(facts(), { dropTags: true, addTags: ['x'] }, 'youtube_shorts').tags, ['x']);
  const f = facts(); assert.equal(applyMetaPolicy(f, {}, 'youtube_shorts'), f);
});
test('policy: title is clamped to the platform limit by cutting the real title, never the owner prefix/suffix', () => {
  const out = applyMetaPolicy(facts({ title: 'x'.repeat(200) }), { titlePrefix: 'PRE', titleSuffix: 'SUF' }, 'youtube_shorts');
  assert.ok(out.title.length <= 100); assert.ok(out.title.startsWith('PRE ') && out.title.endsWith(' SUF'));
});
test('cleanPolicy: sanitises (one line, length limits, # stripped) and rejects > 10 tags', () => {
  assert.deepEqual(cleanPolicy({ titlePrefix: ' a\nb ', addTags: ['#x', 'x', ' y '] }), { titlePrefix: 'a b', addTags: ['x', 'y'] });
  assert.throws(() => cleanPolicy({ addTags: Array.from({ length: 11 }, (_, i) => 't' + i) }), /at most 10/);
});
test('mapping: policy is stored per (source, channel, platform), independent between destinations, returned by list, cleared on remove', () => {
  const store = new Store(':memory:'); const a = createChannel(store, { name: 'Chan A' }, () => true); const b = createChannel(store, { name: 'Chan B' }, () => true); const c = createChannel(store, { name: 'Chan C' }, () => true);
  store.exec(`INSERT INTO sources(id, kind, uri, channel_id, authorized) VALUES (1,'local','r1',?,1)`, a.id);
  setSourceMapping(store, { sourceId: 1, channelId: b.id, delayMin: 15, policy: { titleSuffix: '| B' } }); setSourceMapping(store, { sourceId: 1, channelId: c.id, policy: { dropTags: true } });
  const m = listSourceMappings(store, 1); assert.equal(m.find((x) => x.channelId === b.id)!.policy.titleSuffix, '| B'); assert.equal(m.find((x) => x.channelId === c.id)!.policy.dropTags, true);
  setSourceMapping(store, { sourceId: 1, channelId: b.id, enabled: false }); assert.equal(getMetaPolicy(store, 1, b.id, 'youtube_shorts').titleSuffix, '| B', 'editing another field keeps the policy');
  assert.equal(listSourceMappings(store, 1).find((x) => x.channelId === b.id)!.delayMin, 15);
  setMetaPolicy(store, 1, a.id, 'youtube_shorts', { titlePrefix: 'own' }); assert.equal(getMetaPolicy(store, 1, a.id, 'youtube_shorts').titlePrefix, 'own', "the source's own channel can have a policy too");
  setSourceMapping(store, { sourceId: 1, channelId: b.id, remove: true }); assert.deepEqual(getMetaPolicy(store, 1, b.id, 'youtube_shorts'), {});
});
