import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { ytLang } from '../src/publish/youtube.ts';
import { tmpDir } from './helpers.ts';

const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

test('ytLang: only valid BCP-47 reaches YouTube (INVALID_REQUEST_METADATA fix)', () => {
  assert.equal(ytLang('hinglish'), 'hi'); assert.equal(ytLang('unknown'), undefined); assert.equal(ytLang('auto'), undefined); assert.equal(ytLang(''), undefined); assert.equal(ytLang('en'), 'en'); assert.equal(ytLang('pt-BR'), 'pt-BR'); assert.equal(ytLang('Hindi!'), undefined);
});

test('mapping cascades to child videos; clip delete removes files, blocks published', async () => {
  const dataDir = tmpDir(); const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir, autoRun: false }); const port = await app.start(); const base = `http://127.0.0.1:${port}`; const st = app.store;
  try {
    const r = await (await fetch(`${base}/api/channels`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Second' }) })).json() as { channel: { slug: string } };
    st.exec(`INSERT INTO sources(kind,uri,title,authorized,status,meta_json) VALUES ('youtube_channel','https://youtube.com/@x/videos','x',1,'active','{}')`);
    const parent = st.get<{ id: number }>(`SELECT id FROM sources WHERE kind='youtube_channel'`)!.id;
    st.exec(`INSERT INTO sources(kind,uri,title,authorized,status,meta_json) VALUES ('youtube_video','https://youtube.com/watch?v=a','a',1,'pending',?)`, JSON.stringify({ channelSource: parent }));
    const res = await (await fetch(`${base}/api/sources/${parent}/channel`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: r.channel.slug }) })).json() as { videosMoved: number };
    assert.equal(res.videosMoved, 1);
    const kid = st.get<{ channel_id: number }>(`SELECT channel_id FROM sources WHERE kind='youtube_video'`)!; const ch2 = st.get<{ id: number }>('SELECT id FROM channels WHERE slug=?', r.channel.slug)!;
    assert.equal(kid.channel_id, ch2.id);
    // delete
    st.exec(`INSERT INTO videos(source_id,path,fingerprint) VALUES (?,?,?)`, parent, '/x.mp4', 'fp1'); const vid = st.get<{ id: number }>('SELECT id FROM videos')!.id;
    st.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,fingerprint,status) VALUES (?,?,?,?,?,'rendered')`, vid, 0, 20, 0.5, 'c1'); const cid = st.get<{ id: number }>('SELECT id FROM candidates')!.id;
    const f = join(dataDir, 'e.mp4'); writeFileSync(f, 'x');
    st.exec(`INSERT INTO clips(candidate_id,output_id,edited_path) VALUES (?,?,?)`, cid, 'o1', f); const clip = st.get<{ id: number }>('SELECT id FROM clips')!.id;
    st.exec(`INSERT INTO uploads(clip_id,platform,idempotency_key,remote_id) VALUES (?,?,?,?)`, clip, 'youtube_shorts', 'k1', 'REMOTE');
    assert.equal((await fetch(`${base}/api/clips/${clip}`, { method: 'DELETE', headers: auth })).status, 409);
    st.exec('UPDATE uploads SET remote_id=NULL');
    assert.equal((await fetch(`${base}/api/clips/${clip}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.ok(!existsSync(f)); assert.equal(st.get('SELECT 1 FROM clips WHERE id=?', clip), undefined);
    assert.equal(st.get<{ status: string }>('SELECT status FROM candidates WHERE id=?', cid)!.status, 'rejected');
  } finally { await app.stop(); }
});

test('optimize endpoint: kit without YouTube connection, apply refused clearly', async () => {
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const port = await app.start(); const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/api/channels/main/optimize`, { method: 'POST', headers: auth, body: '{}' }); const j = await r.json() as { ok: boolean; kit: { description: string }; note?: string };
    assert.equal(r.status, 200); assert.ok(j.kit.description.length > 10); assert.match(j.note ?? '', /connect/i);
    assert.equal((await fetch(`${base}/api/channels/main/optimize`, { method: 'POST', headers: auth, body: JSON.stringify({ apply: true }) })).status, 400);
    const a = await fetch(`${base}/api/channels/main/optimize`, { method: 'POST', headers: auth, body: JSON.stringify({ apply: true, confirm: true }) }); assert.equal(a.status, 400); assert.match(((await a.json()) as { error: string }).error, /connect/i);
    assert.ok(((await (await fetch(`${base}/api/channels/main/optimize`, { headers: auth })).json()) as { kit: unknown }).kit);
  } finally { await app.stop(); }
});

test('health: /live /ready open; /metrics needs token and is Prometheus text', async () => {
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const port = await app.start(); const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/live`)).status, 200); assert.equal((await fetch(`${base}/ready`)).status, 200);
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    const t = await (await fetch(`${base}/metrics`, { headers: auth })).text(); assert.match(t, /# TYPE ytclips_free_disk_mb gauge/); assert.ok(!t.includes(TOKEN));
  } finally { await app.stop(); }
});
