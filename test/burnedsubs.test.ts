import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { run } from '../src/util/proc.ts';
import { bottomBandBusy } from '../src/edit/sourcecheck.ts';
import { buildStyledAss } from '../src/edit/captions.ts';
import { tmpDir } from './helpers.ts';

const mk = async (out: string, subs: boolean) => { // 6 s portrait clip; "subs" = dense light/dark stripes in the bottom band (stand-in for burned-in text edges)
  const g = subs ? `format=yuv420p,geq=lum='if(between(Y,H*0.76,H*0.86)*lt(mod(X,8),3),235,lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'` : 'format=yuv420p';
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x335577:s=360x640:d=6:r=10', '-vf', g, out], { timeoutMs: 60_000 }); assert.equal(r.code, 0, r.stderr);
};
test('bottomBandBusy: stripes in the bottom band are detected, a plain frame is not', async () => {
  const d = tmpDir(); await mk(join(d, 'a.mp4'), true); await mk(join(d, 'b.mp4'), false);
  assert.equal((await bottomBandBusy(join(d, 'a.mp4'), 0, 6)).busy, true); assert.equal((await bottomBandBusy(join(d, 'b.mp4'), 0, 6)).busy, false);
});
test('caption lift: MarginV rises by 15% of the height', () => {
  const cues = [{ start: 0, end: 2, text: 'namaste dosto'}] as never;
  const mv = (lift: number) => { const a = buildStyledAss(cues, 0, 3, null, { width: 1080, height: 1920, position: 'bottom', lift } as never).ass; return a.split('\n').filter((l) => l.startsWith('Style: Cap'))[0]!.split(',').slice(-2)[0]; };
  assert.equal(Number(mv(0.15)) - Number(mv(0)), Math.round(1920 * 0.35) - Math.round(1920 * 0.2));
});
