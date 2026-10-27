#!/usr/bin/env python3
"""Active-speaker follow track. Samples ~5 fps, detects faces (OpenCV Haar, offline), links them into tracks by nearest centre,
measures mouth-region motion per track (lower third of the face box, frame-to-frame difference) and picks the person who is
MOST ACTIVE in a sliding ~1.2 s window (with hysteresis so the camera does not jump between people). Prints JSON
{"track": [[t, cx], ...], "faces": N, "speakers": K}: cx = horizontal centre (0..1) of the chosen face, smoothed.
Honest limits: mouth motion is a visual cue, not lip-reading; if nobody moves the largest/central face is kept."""
import sys, json
try:
    import cv2
except Exception:
    print(json.dumps({"track": [], "faces": 0, "error": "opencv_missing"})); sys.exit(0)
path = sys.argv[1]; fps_s = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
cap = cv2.VideoCapture(path); fps = cap.get(cv2.CAP_PROP_FPS) or 25.0; total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
if total <= 0: print(json.dumps({"track": [], "faces": 0, "error": "unreadable"})); sys.exit(0)
try:
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
except Exception:  # e.g. OpenCV 5 builds without the legacy cascade API
    print(json.dumps({"track": [], "faces": 0, "error": "no_cascade"})); sys.exit(0)
step = max(1, int(round(fps / fps_s))); samples = []  # per sample: (t, [ (cx, size, mouthpatch) ])
prev_g = None; i = 0
while True:
    ok = cap.grab()
    if not ok: break
    if i % step == 0:
        ok, fr = cap.retrieve()
        if not ok: break
        sc = 480.0 / fr.shape[1] if fr.shape[1] > 480 else 1.0
        g = cv2.cvtColor(cv2.resize(fr, None, fx=sc, fy=sc) if sc != 1.0 else fr, cv2.COLOR_BGR2GRAY)
        faces = casc.detectMultiScale(g, 1.2, 5, minSize=(30, 30)); fl = []
        for (x, y, w, h) in faces:
            m = g[y + int(h * 0.62): y + h, x + int(w * 0.2): x + int(w * 0.8)]
            fl.append(((x + w / 2.0) / g.shape[1], w * h, cv2.resize(m, (24, 12)) if m.size else None))
        samples.append((i / fps, fl))
    i += 1
if not any(f for _, f in samples): print(json.dumps({"track": [], "faces": 0})); sys.exit(0)
# link faces into tracks by nearest centre (max jump 0.18 of frame width)
tracks = []  # each: list of (sample_idx, cx, size, patch)
for si, (t, fl) in enumerate(samples):
    used = set()
    for (cx, size, patch) in fl:
        best = None; bd = 0.18
        for ti, tr in enumerate(tracks):
            if ti in used or si - tr[-1][0] > 4: continue
            d = abs(tr[-1][1] - cx)
            if d < bd: bd = d; best = ti
        if best is None: tracks.append([(si, cx, size, patch)]); used.add(len(tracks) - 1)
        else: tracks[best].append((si, cx, size, patch)); used.add(best)
tracks = [t for t in tracks if len(t) >= 3]
if not tracks: print(json.dumps({"track": [], "faces": 0})); sys.exit(0)
def motion(tr):
    m = {}
    for a, b in zip(tr, tr[1:]):
        if a[3] is not None and b[3] is not None and b[0] - a[0] <= 2:
            m[b[0]] = float(cv2.absdiff(a[3], b[3]).mean())
    return m
mot = [motion(t) for t in tracks]; pos = [{s[0]: s[1] for s in t} for t in tracks]; siz = [sum(s[2] for s in t) / len(t) for t in tracks]
win = max(1, int(round(1.2 * fps_s))); cur = max(range(len(tracks)), key=lambda k: siz[k]); out = []
for si, (t, _) in enumerate(samples):
    score = []
    for k in range(len(tracks)):
        score.append(sum(mot[k].get(j, 0.0) for j in range(si - win + 1, si + 1)) if si in pos[k] or any(j in pos[k] for j in range(si - 2, si + 1)) else -1)
    best = max(range(len(tracks)), key=lambda k: score[k])
    if best != cur and score[best] > 1.5 * max(score[cur], 1.0) and score[best] > 4.0: cur = best
    c = pos[cur].get(si)
    if c is None:
        near = [pos[cur][j] for j in range(si - 3, si + 4) if j in pos[cur]]
        c = near[0] if near else None
    if c is not None: out.append([round(t, 2), c])
# smooth (moving average) and thin to ~one point per 0.8 s
sm = []
for k in range(len(out)):
    seg = [o[1] for o in out[max(0, k - 2): k + 3]]; sm.append([out[k][0], round(sum(seg) / len(seg), 3)])
thin = []; last = -9
for t, c in sm:
    if t - last >= 0.8: thin.append([t, c]); last = t
print(json.dumps({"track": thin, "faces": len(out), "speakers": len(tracks)}))
