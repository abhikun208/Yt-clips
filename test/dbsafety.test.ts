import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { autoBackup, integrity } from '../src/ops/dbsafety.ts';
import { tmpDir } from './helpers.ts';

test('daily auto backup: one per day, last 7 kept, manual backups untouched, integrity ok', () => {
  const d = tmpDir(); const s = new Store(join(d, 'x.db')); assert.equal(integrity(s).ok, true);
  const day = (n: number) => new Date(Date.UTC(2026, 10, n, 12));
  assert.equal(autoBackup(s, d, day(1)).made, 'auto-2026-11-01.db'); assert.equal(autoBackup(s, d, day(1)).made, null, 'same day: no second snapshot');
  for (let n = 2; n <= 10; n++) autoBackup(s, d, day(n));
  const files = readdirSync(join(d, 'backups', 'auto')).sort(); assert.equal(files.length, 7); assert.equal(files[0], 'auto-2026-11-04.db'); assert.ok(existsSync(join(d, 'backups', 'auto', 'auto-2026-11-10.db')));
  const copy = new Store(join(d, 'backups', 'auto', 'auto-2026-11-10.db')); assert.equal(integrity(copy).ok, true);
});
