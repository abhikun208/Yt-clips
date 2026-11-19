import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every /api/... path the dashboard calls must exist in the server (catches dead buttons / renamed routes).
test('every API path used by ui.html is served by app.ts', () => {
  const ui = readFileSync(new URL('../src/server/ui.html', import.meta.url), 'utf8'); const app = readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const paths = new Set<string>(); for (const m of ui.matchAll(/['"`](\/api\/[A-Za-z0-9_\/.-]*)/g)) paths.add(m[1]!.replace(/\/$/, ''));
  const missing: string[] = [];
  for (const p of paths) {
    const segs = p.split('/').filter(Boolean); // /api/a/b -> a, b ; dynamic ids are concatenated in the UI so the literal ends before them
    const rx = new RegExp(segs.slice(1).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\n]{0,80}?'));
    if (!app.includes(p) && !rx.test(app)) missing.push(p);
  }
  assert.deepEqual(missing, [], 'UI calls routes the server does not have');
  assert.ok(paths.size > 40, `inventory looks wrong (${paths.size})`);
});
