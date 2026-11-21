import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, which } from '../src/util/proc.ts';

test('which finds Node without depending on a POSIX shell', async () => {
  assert.equal(await which('node'), true);
});

test('python3 uses the installed Python interpreter on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  if (!(await which('python'))) return t.skip('Python is not installed');
  assert.equal(await which('python3'), true);
  const result = await run('python3', ['-I', '-c', 'print("python3 alias works")']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /python3 alias works/);
});
