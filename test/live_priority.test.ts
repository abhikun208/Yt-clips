import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, enqueue, claim, setLivePriority } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server/app.ts';
import { tmpDir } from './helpers.ts';

function vid(st: Store, n: number, dur: number): number {
  st.exec(`INSERT OR IGNORE INTO sources(kind, uri, title, authorized, status) VALUES ('local','/s','s',1,'done')`);
  return st.exec(`INSERT INTO videos(source_id, path, fingerprint, size, duration, width, height, fps, has_audio, state) VALUES (1,'/p${n}','f${n}',1,?,1920,1080,30,1,'NEW')`, dur).lastId;
}

test('Live Priority Mode: a live chunk jumps ahead of a shorter backlog video; switching it off restores shortest-first', () => {
  const st = new Store(loadConfig(process.cwd(), { dataDir: tmpDir() }).dbPath);
  const old = vid(st, 1, 60); const live = vid(st, 2, 300); st.exec(`INSERT INTO kv(k,v) VALUES (?, '1')`, `live:video:${live}`);
  enqueue(st, 'analyze', `analyze:${old}`); enqueue(st, 'analyze', `analyze:${live}`);
  assert.equal(claim(st)!.key, `analyze:${live}`, 'live first although longer');
  const st2 = new Store(loadConfig(process.cwd(), { dataDir: tmpDir() }).dbPath); const a = vid(st2, 1, 60); const b = vid(st2, 2, 300); st2.exec(`INSERT INTO kv(k,v) VALUES (?, '1')`, `live:video:${b}`);
  setLivePriority(st2, false); enqueue(st2, 'analyze', `analyze:${a}`); enqueue(st2, 'analyze', `analyze:${b}`);
  assert.equal(claim(st2)!.key, `analyze:${a}`, 'priority off: shortest first as before');
});

test('Live API: status + priority toggle', async () => {
  const T = 'test-token-0123456789'; const h = { authorization: `Bearer ${T}`, 'content-type': 'application/json' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: T, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    assert.equal((await (await fetch(base + '/api/live', { headers: h })).json() as { priority: boolean }).priority, true);
    const r = await (await fetch(base + '/api/live/priority', { method: 'POST', headers: h, body: JSON.stringify({ on: false }) })).json() as { priority: boolean };
    assert.equal(r.priority, false);
    assert.equal((await (await fetch(base + '/api/live', { headers: h })).json() as { priority: boolean }).priority, false);
  } finally { await app.stop(); }
});
