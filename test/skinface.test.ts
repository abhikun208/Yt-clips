import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { skinFaceCenter } from '../src/edit/skinface.ts';
import { tmpDir } from './helpers.ts';

const mk = (name: string, vf: string) => { const f = join(tmpDir(), name); const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=6:r=10', '-vf', vf, '-pix_fmt', 'yuv420p', f]); assert.equal(r.status, 0, String(r.stderr)); return f; };
test('face-only fallback: a skin-coloured head at the right is found; a plain/striped scene gives none', () => {
  const face = mk('face.mp4', 'drawbox=x=420:y=40:w=90:h=120:color=0xE0AC8C:t=fill');
  const cx = skinFaceCenter(face, 0, 6, 8); assert.ok(cx !== undefined && cx > 0.6 && cx < 0.8, `cx=${cx}`);
  assert.equal(skinFaceCenter(mk('plain.mp4', 'null'), 0, 6, 8), undefined);
  assert.equal(skinFaceCenter(mk('stripe.mp4', 'drawbox=x=0:y=100:w=640:h=10:color=0xE0AC8C:t=fill'), 0, 6, 8), undefined);
});
