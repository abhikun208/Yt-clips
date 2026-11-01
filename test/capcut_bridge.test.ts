import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, makeVideo } from './capcut_helpers.ts';
import { applySkips } from '../src/analysis/boundaries.ts';
import { makeClipDraft, draftsRoot } from '../src/capcut/bridge.ts';
import { openDraft } from '../src/capcut/draft.ts';
import { diagnose } from '../src/capcut/doctor.ts';
import { loadConfig } from '../src/config.ts';

test('intro/outro skip: first and last 90 s never used on long videos, capped to 20% on short ones, owner override wins', () => {
  const a = applySkips(1800, 0, 1800, { skipHeadSec: 90, skipTailSec: 90 }); assert.equal(a.introEnd, 90); assert.equal(a.outroStart, 1710);
  const b = applySkips(400, 0, 400, { skipHeadSec: 90, skipTailSec: 90 }); assert.equal(b.introEnd, 80); assert.equal(b.outroStart, 320); const sh = applySkips(32, 4, 28, { skipHeadSec: 90, skipTailSec: 90 }); assert.equal(sh.introEnd, 4); assert.equal(sh.outroStart, 28);
  const c = applySkips(1800, 0, 1800, { skipHeadSec: 90, skipTailSec: 90, override: { introEnd: 5, outroStart: 1790 } }); assert.equal(c.introEnd, 0); assert.equal(c.outroStart, 1800);
  const d = applySkips(1800, 200, 1000, { skipHeadSec: 90, skipTailSec: 90 }); assert.equal(d.introEnd, 200); assert.equal(d.outroStart, 1000, 'detected boundaries that are already further in are kept');
});
test('makeClipDraft builds a valid 9:16 draft with subtitles from a clip', () => {
  const r = tmp(); const v = makeVideo(r); const cfg = loadConfig(undefined, { dataDir: join(r, 'data') });
  const out = makeClipDraft(cfg, { videoPath: v, name: 'clip_x', cues: [{ start: 0.5, end: 2, text: 'namaste' }, { start: 2.5, end: 4, text: 'dosto' }, { start: 4.5, end: 99, text: 'long end' }] });
  assert.ok(out.dir.startsWith(draftsRoot(cfg))); assert.equal(out.subtitles, 3); assert.deepEqual(out.remaining, []);
  const d = openDraft(out.dir); assert.equal(d.json.canvas_config.height, 1920); assert.equal(diagnose(d.json).filter((f) => f.level === 'error').length, 0);
  assert.ok(readFileSync(join(out.dir, 'draft_meta_info.json'), 'utf8').includes('clip_x'));
});
