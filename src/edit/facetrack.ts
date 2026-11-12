/**
 * Pan damping for the face-follow crop. The detector (tools/face_track.py, OpenCV, separate process so the event loop is never blocked)
 * picks the face (largest / most central / active speaker) and returns [seconds, centreX 0..1] keyframes. This turns them into a camera move:
 *  - dead-band: tiny jitters are ignored (camera holds still)
 *  - EMA: the camera eases toward the face instead of snapping
 *  - speed cap: a sudden jump (new speaker, fast head move) pans at a limited speed
 * `sensitivity` 0..1 (default 0.5): 0 = slow, steady camera; 1 = follows quickly. No faces / empty track -> [] (caller keeps the static centre crop).
 */
export function smoothTrack(track: [number, number][], sensitivity = 0.5): [number, number][] {
  const s = Math.min(1, Math.max(0, Number.isFinite(sensitivity) ? sensitivity : 0.5));
  const pts = track.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)).map(([t, v]) => [t, Math.min(1, Math.max(0, v))] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return pts;
  const alpha = 0.15 + 0.7 * s, dead = 0.012 + 0.06 * (1 - s), maxSpeed = 0.12 + 0.7 * s; // fraction of the frame width per second
  const out: [number, number][] = [[pts[0]![0], pts[0]![1]]]; let cur = pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    const [t, target] = pts[i]!; const dt = Math.max(0.001, t - pts[i - 1]![0]);
    if (Math.abs(target - cur) > dead) { const want = cur + (target - cur) * alpha; const lim = maxSpeed * dt; cur += Math.max(-lim, Math.min(lim, want - cur)); }
    out.push([t, +cur.toFixed(4)]);
  }
  return out;
}
