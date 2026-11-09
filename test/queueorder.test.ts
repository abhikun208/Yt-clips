import { test } from 'node:test'; import assert from 'node:assert/strict';
import { Store, enqueue, claim } from '../src/db.ts';
test('claim: renders first, then shortest video analysis first', () => {
  const s = new Store(':memory:');
  const ins = (d: number) => { s.exec(`INSERT INTO videos(path,fingerprint,duration,state) VALUES(?,?,?, 'NEW')`, `/x${d}`, `f${d}`, d); return s.get<{ id: number }>('SELECT id FROM videos WHERE fingerprint=?', `f${d}`)!.id; };
  const long = ins(7200), short = ins(30);
  enqueue(s, 'analyze', `analyze:${long}`); enqueue(s, 'analyze', `analyze:${short}`); enqueue(s, 'render', 'render:1');
  assert.equal(claim(s)!.key, 'render:1'); assert.equal(claim(s)!.key, `analyze:${short}`); assert.equal(claim(s)!.key, `analyze:${long}`);
});
test('fresh-start parks old work and deletes nothing', async () => {
  const { freshStart } = await import('../src/ops/freshstart.ts');
  const s = new Store(':memory:'); s.exec(`INSERT INTO videos(path,fingerprint,duration,state) VALUES('/a','fa',100,'ANALYZING')`); enqueue(s, 'analyze', 'analyze:1');
  const r = freshStart(s); assert.equal(r.videosParked, 1); assert.equal(r.jobsCancelled, 1);
  assert.equal(claim(s), undefined); assert.equal(s.get<{ n: number }>('SELECT count(*) n FROM videos')!.n, 1);
});
test('doctor closes DEAD rerender jobs of deleted clips ("Unknown clip 4", capital U as the app writes it)', async () => {
  const { runDoctor } = await import('../src/ops/doctor.ts'); const { testConfig } = await import('./helpers.ts');
  const s = new Store(':memory:'); s.exec(`INSERT INTO jobs(kind, key, state, last_error) VALUES ('rerender','rerender:4','DEAD','Unknown clip 4')`);
  await runDoctor(s, testConfig());
  assert.equal(s.get<{ state: string }>(`SELECT state FROM jobs WHERE key='rerender:4'`)!.state, 'DONE');
});
test('uploading the same file again wakes a PARKED video', async () => {
  const { ingestLocal } = await import('../src/sources/local.ts'); const { freshStart } = await import('../src/ops/freshstart.ts'); const { testConfig, tmpDir, makeFixture } = await import('./helpers.ts');
  const { join } = await import('node:path'); const cfg = testConfig(); const s = new Store(':memory:'); const d = tmpDir(); const f = join(d, 'a.mp4'); await makeFixture(f, 3);
  const a = await ingestLocal(s, cfg, f); freshStart(s); assert.equal(s.get<{ state: string }>('SELECT state FROM videos WHERE id=?', a.videoId)!.state, 'PARKED');
  const b = await ingestLocal(s, cfg, f); assert.equal(b.duplicate, true); assert.equal(s.get<{ state: string }>('SELECT state FROM videos WHERE id=?', a.videoId)!.state, 'NEW');
});
