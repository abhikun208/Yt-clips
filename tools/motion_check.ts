// Real motion-smoothness measurement: renders a wide source (fixed marker) through the SAME crop expression the editor uses,
// finds the marker in every output frame and prints the per-frame camera step. A staircase would show 0,0,0,JUMP; smooth shows ~constant steps.
import { spawnSync } from 'node:child_process';
import { trackExpr } from '../src/edit/filters.ts';
const W = 1920, H = 1080, FPS = 30, N = 90;
const track: [number, number][] = Array.from({ length: 12 }, (_, i) => [i * 0.4, 0.3 + 0.4 * (i % 2 ? 1 : 0) * 0.5 + i * 0.03] as [number, number]); // zig-zag + drift, 0.4 s apart like face_track.py
const xe = trackExpr(track), cw = 'trunc(ih*9/16/2)*2';
// source: black with a white 8px vertical bar at x=960 (fixed) -> its position in the crop = 960 - cropX
const f = `color=black:s=${W}x${H}:r=${FPS},drawbox=x=960:y=0:w=8:h=${H}:color=white:t=fill,crop=w=${cw}:h=ih:x='max(0,min(iw-ow,iw*${xe}-ow/2))':y=0,format=gray`;
const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', f, '-frames:v', String(N), '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
if (r.status !== 0) { console.error(String(r.stderr)); process.exit(1); }
const ow = 606, fs = ow * H, pos: number[] = [];
for (let i = 0; i < N; i++) { const b = r.stdout.subarray(i * fs, (i + 1) * fs); let x = -1; for (let k = 0; k < ow; k++) if (b[k + 540 * ow]! > 128) { x = k; break; } pos.push(x); }
const ok = pos.map((p) => p >= 0 && p < ow - 1); // marker inside the window (when the camera is parked at the edge the marker is out of view -> skip)
const cam = pos.map((p) => 960 - p);
const steps: number[] = []; for (let i = 1; i < N; i++) if (ok[i] && ok[i - 1]) steps.push(cam[i]! - cam[i - 1]!);
const zero = steps.filter((s) => s === 0).length;
console.log('frames', N, 'camera x per frame (px):', cam.filter((_, i) => ok[i]).join(' '));
console.log('per-frame step:', steps.join(' '));
const turn = steps.filter((x, i) => i && Math.sign(x) !== Math.sign(steps[i - 1]!) && Math.abs(steps[i - 1]!) > 12 && Math.abs(x) > 12).length; // sign flips with no pass through ~0 = hard kink
console.log(`frames with ZERO movement (marker visible): ${zero}/${steps.length}; max step ${Math.max(...steps.map(Math.abs))}px (frame width ${ow}px)`);
console.log(`largest step-to-step velocity change: ${Math.max(...steps.slice(1).map((x, i) => Math.abs(x - steps[i]!)))}px/frame^2; hard kinks: ${turn}`);
