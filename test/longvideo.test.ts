import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWindow } from '../src/sources/youtube.ts';
import { sourceSettings, cleanSettings } from '../src/sources/sourcecfg.ts';
import { loadConfig } from '../src/config.ts';
import { tmpDir } from './helpers.ts';

test('regression: no arbitrary duration rejection by default (0 = unlimited) and 0 is accepted in settings', () => {
  const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() });
  assert.equal(cfg.youtube.maxDurationMin, 0); assert.equal(sourceSettings({}, cfg).maxDurationMin, 0);
  assert.equal((cleanSettings({ maxDurationMin: 0 }) as { maxDurationMin: number }).maxDurationMin, 0);
  assert.equal(sourceSettings({ maxDurationMin: 120 }, cfg).maxDurationMin, 120, 'an explicit owner limit still works');
});

test('a 6-hour stream is fetched window-by-window (60 min), never as one file; short and unknown-length videos download normally', () => {
  const dur = 6 * 3600; const m: { duration: number; nextStart?: number; part?: number } = { duration: dur }; const parts: number[][] = [];
  for (let i = 0; i < 20; i++) { const w = nextWindow(m, 60)!; parts.push([w.range.start, w.range.end]); m.nextStart = w.range.end; m.part = w.part; if (w.last) break; }
  assert.equal(parts.length, 6); assert.deepEqual(parts[0], [0, 3600]); assert.deepEqual(parts[5], [18000, 21600]);
  assert.equal(nextWindow({ duration: 3000 }, 60), null, 'under the window: normal download');
  assert.equal(nextWindow({ duration: 3800 }, 60), null, 'within 10% of the window: one download');
  assert.equal(nextWindow({}, 60), null, 'unknown length (live): normal path');
  assert.equal(nextWindow({ duration: dur, range: { start: 1, end: 2 } }, 60), null, 'an explicit range wins');
  assert.equal(nextWindow({ duration: dur }, 0), null, 'sectioning can be switched off');
});
