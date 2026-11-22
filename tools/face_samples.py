#!/usr/bin/env python3
"""All-faces sampler for the framing advisor (src/framing/advisor.ts). Separate from face_track.py (which only returns the chosen speaker).
Samples ~fps_s frames/s, detects every face with the shared detector (tools/facedet.py), links faces into tracks by nearest centre and scores
how much each track's mouth region moves (frame-to-frame difference of the lower third of the box) -> "speaking" 0..1.
Prints {"samples":[{"t":sec,"faces":[{"x","y","w","h","speaking"}]}], "faces":N} (all coordinates are fractions of the frame).
Honest limits: mouth motion is a visual cue, not lip-reading or diarization. Missing OpenCV / no detector / unreadable video -> {"samples":[],"faces":0,"error":...}."""
import sys, json, os
try:
    import cv2
except Exception:
    print(json.dumps({"samples": [], "faces": 0, "error": "opencv_missing"})); sys.exit(0)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from facedet import load as _load
path = sys.argv[1]; fps_s = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
cap = cv2.VideoCapture(path); fps = cap.get(cv2.CAP_PROP_FPS) or 25.0; total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
if total <= 0: print(json.dumps({"samples": [], "faces": 0, "error": "unreadable"})); sys.exit(0)
detect = _load(cv2)
if detect is None: print(json.dumps({"samples": [], "faces": 0, "error": "no_detector"})); sys.exit(0)
step = max(1, int(round(fps / fps_s))); i = 0; out = []; tracks = []  # track: [last_sample_idx, cx, last_patch]
n = 0
while True:
    if not cap.grab(): break
    if i % step == 0:
        ok, fr = cap.retrieve()
        if not ok: break
        sc = 480.0 / fr.shape[1] if fr.shape[1] > 480 else 1.0
        fr2 = cv2.resize(fr, None, fx=sc, fy=sc) if sc != 1.0 else fr
        g = cv2.cvtColor(fr2, cv2.COLOR_BGR2GRAY); H, W = g.shape[:2]; si = len(out); faces = []; used = set()
        for (x, y, w, h) in detect(fr2):
            cx = (x + w / 2.0) / W
            m = g[y + int(h * 0.62): y + h, x + int(w * 0.2): x + int(w * 0.8)]
            patch = cv2.resize(m, (24, 12)) if m.size else None
            best = None; bd = 0.18
            for ti, tr in enumerate(tracks):
                if ti in used or si - tr[0] > 4: continue
                d = abs(tr[1] - cx)
                if d < bd: bd = d; best = ti
            speaking = 0.0
            if best is None: tracks.append([si, cx, patch]); used.add(len(tracks) - 1)
            else:
                tr = tracks[best]
                if tr[2] is not None and patch is not None: speaking = min(1.0, float(cv2.absdiff(tr[2], patch).mean()) / 12.0)
                tr[0] = si; tr[1] = cx; tr[2] = patch; used.add(best)
            faces.append({"x": round(x / W, 4), "y": round(y / H, 4), "w": round(w / W, 4), "h": round(h / H, 4), "speaking": round(speaking, 3)})
        n += len(faces); out.append({"t": round(i / fps, 2), "faces": faces})
    i += 1
print(json.dumps({"samples": out, "faces": n}))
