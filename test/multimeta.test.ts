import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { metaPages, assignMetaPage } from '../src/publish/socialOauth.ts';
import { prettySource } from '../src/sources/youtube.ts';
import { explainConnError } from '../src/connections.ts';

test('multi-account Meta: each channel can publish to its own Page + Instagram; default stays untouched', () => {
  const cfg = loadConfig(tmpDir()); const sec = SecretStore.forData(cfg.dataDir);
  sec.write('facebook', { access_token: 'DEFAULT', page_id: '1', page_name: 'First' });
  sec.write('meta-pages', { pages: [{ id: '1', name: 'First', access_token: 'T1', ig_user_id: 'ig1' }, { id: '2', name: 'Second', access_token: 'T2', ig_user_id: null }], user_token: 'U', perms: ['pages_manage_posts'] });
  assert.deepEqual(metaPages(cfg), [{ id: '1', name: 'First', instagram: true }, { id: '2', name: 'Second', instagram: false }]);
  assert.ok(!JSON.stringify(metaPages(cfg)).includes('T1'), 'no token leaves');
  assert.deepEqual(assignMetaPage(cfg, 'gaming', '2'), { page: 'Second', instagram: false });
  assert.equal(sec.read<{ access_token: string }>('facebook-gaming')!.access_token, 'T2'); assert.equal(sec.read<{ access_token: string }>('facebook')!.access_token, 'DEFAULT');
  assert.deepEqual(assignMetaPage(cfg, 'vlog', '1'), { page: 'First', instagram: true }); assert.equal(sec.read<{ ig_user_id: string }>('instagram-vlog')!.ig_user_id, 'ig1');
  assert.throws(() => assignMetaPage(cfg, 'x', '99'), /Page not found/); assert.throws(() => assignMetaPage(cfg, '../x', '1'), /slug/);
  assert.equal(assignMetaPage(cfg, 'gaming', ''), null);
});
test('source label shows the channel handle/name, not the whole link', () => {
  assert.equal(prettySource('https://www.youtube.com/@TeamUnknown/videos'), '@TeamUnknown'); assert.equal(prettySource('https://www.youtube.com/channel/UCabc123'), 'UCabc123');
  assert.equal(prettySource('https://www.youtube.com/watch?v=abc'), 'YouTube video');
});
test('YouTube auth messages: unauthorized_client is a client mismatch, invalid_grant is the Testing-mode expiry', () => {
  assert.match(explainConnError('AUTH_REVOKED: unauthorized_client — reconnect')!, /AUR Client ID|NAHI hai/);
  assert.match(explainConnError('AUTH_REVOKED: invalid_grant — reconnect')!, /Testing.*Publish app/);
});

import { autoNameChannel } from '../src/publish/webauth.ts';
import { createChannel, getChannel } from '../src/channels.ts';
test('several YouTube accounts: placeholder channel takes the real YouTube name; a name the owner chose is never overwritten', () => {
  const store = new Store(join(tmpDir(), 'm.db')); const a = createChannel(store, { name: 'YouTube account 2' }, () => true); const b = createChannel(store, { name: 'Decider Gaming' }, () => true);
  autoNameChannel(store, a, 'Team Unknown'); autoNameChannel(store, b, 'Other Name');
  assert.equal(getChannel(store, a.id).name, 'Team Unknown'); assert.equal(getChannel(store, b.id).name, 'Decider Gaming');
  assert.equal(getChannel(store, a.id).slug, 'youtube-account-2', 'slug (and so the token secret) never changes on rename');
});
