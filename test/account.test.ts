import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { getChannel } from '../src/channels.ts';
import { buildAccountKit } from '../src/seo/account.ts';

test('account kit: from config only, no invented links, limits respected', () => {
  const s = new Store(':memory:'); const ch = getChannel(s, 'main');
  const kit = buildAccountKit(s, { ...ch, name: 'Team Unknown', profile: 'gaming', config: { language: 'hi', hashtags: ['#TeamUnknown'], links: [{ label: 'Discord', url: 'https://discord.gg/x' }] } });
  assert.ok(kit.description.length <= 1000 && kit.keywords.length <= 480 && kit.bio.length <= 150);
  assert.match(kit.description, /Team Unknown/); assert.ok(kit.description.includes('https://discord.gg/x'));
  const urls = kit.description.match(/https?:\/\/\S+/g) ?? []; assert.deepEqual(urls, ['https://discord.gg/x']);
  assert.ok(kit.playlists.length >= 1); assert.ok(kit.checklist.some((c) => c.item.includes('links') && c.ok));
});
