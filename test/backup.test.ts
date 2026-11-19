import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { Store } from '../src/db.ts';
import { tmpDir } from './helpers.ts';

test('database backup: POST creates a consistent snapshot copy (no secrets), GET lists it', async () => {
  const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }; const dir = tmpDir();
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: dir, autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    assert.equal((await (await fetch(base + '/api/backup', { headers: auth })).json() as { backups: unknown[] }).backups.length, 0);
    const r = await (await fetch(base + '/api/backup', { method: 'POST', headers: auth, body: '{}' })).json() as { backups: { name: string }[] }; assert.equal(r.backups.length, 1);
    const f = join(dir, 'backups', r.backups[0]!.name); assert.ok(existsSync(f)); assert.deepEqual(readdirSync(join(dir, 'backups')).filter((x) => !x.endsWith('.db')), [], 'only the db snapshot, nothing else'); const copy = new Store(f); assert.ok(copy.get('SELECT 1 FROM sqlite_master WHERE name=?', 'uploads'), 'backup is a real database');
  } finally { await app.stop?.(); }
});
