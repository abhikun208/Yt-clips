import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { runSmoke } from '../src/smoke.ts';
import { tmpDir } from './helpers.ts';

test('smoke: runs every configured real-service check, reports PASS/FAIL/SKIP honestly (fake endpoint here; owner runs it for real)', async () => {
  const hits: string[] = [];
  const srv = createServer((req, res) => { hits.push(req.url ?? ''); req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url?.includes('chat') ? JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) : JSON.stringify({ text: '', segments: [] })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const old = { ...process.env }; Object.assign(process.env, { LLM_API_BASE: base, STT_API_BASE: base });
  try {
    const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() }); const res = await runSmoke(new Store(':memory:'), cfg);
    const by = (p: string) => res.find((r) => r.name.startsWith(p))!;
    assert.equal(by('ffmpeg').status, 'PASS'); assert.equal(by('LLM slot 1').status, 'PASS'); assert.equal(by('STT').status, 'PASS');
    assert.equal(by('YouTube login (main)').status, 'SKIP'); assert.equal(by('YouTube PRIVATE upload').status, 'SKIP');
    assert.ok(hits.some((h) => h.includes('chat/completions')) && hits.some((h) => h.includes('audio/transcriptions')));
  } finally { srv.close(); process.env = old; }
});
