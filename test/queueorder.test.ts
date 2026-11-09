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
