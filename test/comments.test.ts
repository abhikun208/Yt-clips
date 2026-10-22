import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SecretStore } from '../src/publish/secrets.ts';
import { startLoopbackFlow, connectedScope, YT_FORCE_SSL_SCOPE } from '../src/publish/oauth.ts';
import { collectYoutubeComments, postComment } from '../src/publish/service.ts';
import { setCommentStatus } from '../src/comments/comments.ts';
import { startFake } from './fakeGoogle.ts';
import { tmpDir } from './helpers.ts';

test('loopback OAuth (PKCE): browser redirect with code stores refresh token + scope; bad state rejected; scope recorded', async () => {
  const f = await startFake(); const old = { ...process.env }; Object.assign(process.env, { YT_OAUTH_BASE: f.base, YT_OAUTH_AUTH_BASE: `${f.base}/auth` });
  try {
    const secrets = new SecretStore(tmpDir(), undefined); const flow = await startLoopbackFlow(secrets, { clientId: 'cid', clientSecret: 'cs' });
    const au = new URL(flow.authUrl); assert.equal(au.searchParams.get('scope'), YT_FORCE_SSL_SCOPE); assert.equal(au.searchParams.get('code_challenge_method'), 'S256'); assert.equal(au.searchParams.get('access_type'), 'offline');
    const redirect = au.searchParams.get('redirect_uri')!; const state = au.searchParams.get('state')!;
    assert.equal((await fetch(`${redirect}?code=AUTHCODE&state=WRONG`)).status, 400); await assert.rejects(flow.done, /state mismatch/);
    const f2 = await startLoopbackFlow(secrets, { clientId: 'cid', clientSecret: 'cs' }); const u2 = new URL(f2.authUrl);
    assert.equal((await fetch(`${u2.searchParams.get('redirect_uri')}?code=AUTHCODE&state=${u2.searchParams.get('state')}`)).status, 200); await f2.done;
    assert.equal(connectedScope(secrets), YT_FORCE_SSL_SCOPE); void state;
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});

test('comments: collect (own comment dropped, spam flagged), approval flow, links rejected, gate/scope/daily-cap enforced, real post only when everything allows', async () => {
  const f = await startFake(); const old = { ...process.env };
  Object.assign(process.env, { YT_API_BASE: f.base, YT_OAUTH_BASE: f.base, YT_OAUTH_CLIENT_ID: 'c', YT_OAUTH_CLIENT_SECRET: 's' });
  try {
    const dataDir = tmpDir(); const secrets = new SecretStore(join(dataDir, 'secrets'), undefined); secrets.write('youtube', { refresh_token: 'REFRESH-TOKEN-XYZ' }); // device-flow style: no force-ssl
    const store = new Store(':memory:'); store.exec(`INSERT INTO videos(id,path,fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id,video_id,start_sec,end_sec,score,fingerprint) VALUES (1,1,0,5,.5,'c')`); store.exec(`INSERT INTO clips(id,candidate_id,output_id) VALUES (1,1,'o')`);
    store.exec(`INSERT INTO uploads(clip_id,platform,state,idempotency_key,remote_id) VALUES (1,'youtube_shorts','PUBLISHED','k','vid1')`);
    const cfgOff = loadConfig(process.cwd(), { dataDir, overrides: { comments: { maxRepliesPerDay: 2 } } });
    const r = await collectYoutubeComments(store, cfgOff); assert.equal(r.newComments, 3, JSON.stringify(r)); assert.equal((await collectYoutubeComments(store, cfgOff)).newComments, 0, 'idempotent');
    const rows = store.all<any>('SELECT remote_id, class, status, draft FROM comments ORDER BY remote_id'); assert.deepEqual(rows.map((x) => x.remote_id), ['c1', 'c3', 'c4']);
    assert.equal(rows[0].class, 'question'); assert.equal(rows[1].status, 'flagged'); assert.equal(rows[1].draft, null); assert.equal(rows[2].class, 'praise');
    const id = (rid: string) => store.get<{ id: number }>('SELECT id FROM comments WHERE remote_id=?', rid)!.id;
    assert.throws(() => setCommentStatus(store, id('c3'), 'approve'), /nothing to approve/); assert.throws(() => setCommentStatus(store, id('c1'), 'edit', 'visit http://x.com'), /links/);
    setCommentStatus(store, id('c1'), 'edit', 'Tutorial jaldi aayega 🙏'); await assert.rejects(postComment(store, cfgOff, id('c1')), /COMMENTS_DISABLED/);
    const on = loadConfig(process.cwd(), { dataDir, overrides: { gates: { commentsAutoPost: true }, comments: { maxRepliesPerDay: 2 } } });
    await assert.rejects(postComment(store, on, id('c1')), /not approved/); setCommentStatus(store, id('c1'), 'approve');
    const before = f.log.length; await assert.rejects(postComment(store, on, id('c1')), /AUTH_SCOPE/); assert.equal(f.log.length, before, 'scope checked locally, no request sent');
    secrets.write('youtube', { refresh_token: 'REFRESH-TOKEN-XYZ', scope: YT_FORCE_SSL_SCOPE });
    f.opts.commentScopeOk = false; await assert.rejects(postComment(store, on, id('c1')), /AUTH_SCOPE/); assert.equal(store.get<{ status: string }>('SELECT status FROM comments WHERE id=?', id('c1'))!.status, 'approved', 'failed post leaves it approved');
    f.opts.commentScopeOk = true; await postComment(store, on, id('c1'));
    const sent = (f as any).replies[0]; assert.equal(sent.parentId, 'c1'); assert.equal(sent.textOriginal, 'Tutorial jaldi aayega 🙏'); assert.equal(store.get<{ status: string }>('SELECT status FROM comments WHERE id=?', id('c1'))!.status, 'posted');
    setCommentStatus(store, id('c4'), 'approve'); await postComment(store, on, id('c4')); store.exec(`UPDATE comments SET status='approved' WHERE remote_id='c3'`, ); store.exec(`UPDATE comments SET draft='x' WHERE remote_id='c3'`);
    await assert.rejects(postComment(store, on, id('c3')), /QUOTA_EXCEEDED: 2 replies/, 'daily cap');
  } finally { await f.close(); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
