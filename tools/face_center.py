#!/usr/bin/env python3
"""Sample frames from a video and print JSON {"cx": float|null, "faces": int, "samples": int}.
cx = median horizontal centre (0..1) of the largest detected face per sample. Uses OpenCV Haar cascade (offline)."""
import json, sys
try:
    import cv2
except Exception as e:
    print(json.dumps({"cx": None, "faces": 0, "samples": 0, "error": "opencv_missing"})); sys.exit(0)

path = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 12
cap = cv2.VideoCapture(path)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
w = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0
if total <= 0 or w <= 0:
    print(json.dumps({"cx": None, "faces": 0, "samples": 0, "error": "unreadable"})); sys.exit(0)
casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
xs = []
for i in range(n):
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * (i + 0.5) / n))
    ok, fr = cap.read()
    if not ok: continue
    scale = 480.0 / fr.shape[1] if fr.shape[1] > 480 else 1.0
    g = cv2.cvtColor(cv2.resize(fr, None, fx=scale, fy=scale) if scale != 1.0 else fr, cv2.COLOR_BGR2GRAY)
    faces = casc.detectMultiScale(g, 1.2, 5, minSize=(30, 30))
    if len(faces):
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        xs.append((x + fw / 2.0) / g.shape[1])
xs.sort()
print(json.dumps({"cx": xs[len(xs) // 2] if xs else None, "faces": len(xs), "samples": n}))
