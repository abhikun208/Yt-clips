import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { runDoctor, UPLOAD_RULES } from '../src/ops/doctor.ts';
import { testConfig } from './helpers.ts';

function seed(st: Store, err: string, remote: string | null = null) {
  st.exec(`INSERT INTO videos(path,fingerprint) VALUES ('/nope.mp4','f')`); st.exec(`INSERT INTO candidates(video_id,start_sec,end_sec,score,fingerprint,category,transcript,language) VALUES (1,0,20,.5,'c','general','Bhai yeh clutch dekho kitna zabardast tha. Maine akele pura squad khatam kar diya aur booyah mara.','hinglish')`);
  st.exec(`INSERT INTO clips(candidate_id,output_id,edited_path,qc_pass,metadata_json) VALUES (1,'o','/nope.mp4',1,'{"title":"x","description":"y"}')`);
  st.exec(`INSERT INTO uploads(clip_id,platform,state,idempotency_key,remote_id,error) VALUES (1,'youtube_shorts','FAILED','k',?,?)`, remote, err);
}

test('rules classify the real YouTube error the owner hit and the usual suspects', () => {
  const k = (e: string) => UPLOAD_RULES.find((r) => r.re.test(e))?.kind;
  assert.equal(k('videos.insert (init) failed: HTTP 400 INVALID_REQUEST_METADATA'), 'meta');
  assert.equal(k('QUOTA_EXCEEDED: units 9990+50 > 10000'), 'defer');
  assert.equal(k('AUTH_REVOKED: unauthorized'), 'manual');
  assert.equal(k('network error: fetch failed'), 'retry');
  assert.equal(k('processingFailed'), 'manual');
});
test('doctor: metadata error → metadata rebuilt from speech; quota → deferred, not hammered; auth → owner', async () => {
  const cfg = testConfig(); const st = new Store(':memory:'); seed(st, 'videos.insert (init) failed: HTTP 400 INVALID_REQUEST_METADATA');
  const r = await runDoctor(st, cfg, { now: 1_000_000 });
  const m = JSON.parse(st.get<{ metadata_json: string }>('SELECT metadata_json FROM clips')!.metadata_json) as { description: string; generic: boolean };
  assert.equal(m.generic, false); assert.match(m.description, /clutch|squad|booyah/i);
  assert.ok(r.items.some((i) => i.area.startsWith('upload #1')));
  st.exec(`UPDATE uploads SET error='QUOTA_EXCEEDED: units 1+50 > 10000', state='FAILED'`);
  const q = await runDoctor(st, cfg, { now: 2_000_000 }); assert.ok(q.items.some((i) => i.result === 'deferred'));
  const q2 = await runDoctor(st, cfg, { now: 2_000_500 }); assert.ok(q2.items.some((i) => i.result === 'deferred' && /waiting until/.test(i.action)), 'second run waits instead of retrying');
  st.exec(`UPDATE uploads SET error='AUTH_REVOKED: unauthorized', state='FAILED'`); st.exec(`DELETE FROM kv WHERE k LIKE 'doctor:defer:%'`);
  const a = await runDoctor(st, cfg, { now: 3_000_000 }); assert.ok(a.items.some((i) => i.result === 'manual' && /reconnect/i.test(i.action)));
});
test('doctor re-queues transient dead jobs once or twice, never non-transient ones', async () => {
  const cfg = testConfig(); const st = new Store(':memory:');
  st.exec(`INSERT INTO jobs(kind,key,state,last_error) VALUES ('render','render:1','DEAD','fetch failed: ETIMEDOUT')`); st.exec(`INSERT INTO jobs(kind,key,state,last_error) VALUES ('render','render:2','DEAD','bad data in file')`);
  await runDoctor(st, cfg);
  assert.equal(st.get<{ state: string }>(`SELECT state FROM jobs WHERE key='render:1'`)!.state, 'PENDING'); assert.equal(st.get<{ state: string }>(`SELECT state FROM jobs WHERE key='render:2'`)!.state, 'DEAD');
  const r = await runDoctor(st, cfg, { fix: false }); assert.ok(Array.isArray(r.items));
});
