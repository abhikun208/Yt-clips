#!/usr/bin/env python3
"""Facial-expression signal for a clip window: python3 -I face_mood.py VIDEO START_SEC END_SEC [N] [MODEL_PATH]
Prints one JSON line {"faces":n,"samples":n,"smile":0..1,"surprise":0..1,"sad":0..1,"anger":0..1} (means over frames with a face) or {"error":...}.
Uses MediaPipe FaceLandmarker blendshapes (offline after the 3.7 MB model is downloaded once to MODEL_PATH). Missing mediapipe/opencv/model => {"error":...}, never a crash."""
import json, sys, os

def out(d):
    print(json.dumps(d)); sys.exit(0)

URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
try:
    path, a, b = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 6
    model = sys.argv[5] if len(sys.argv) > 5 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "face_landmarker.task")
except Exception:
    out({"error": "usage"})
try:
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision
except Exception as e:
    out({"error": "mediapipe_or_opencv_missing"})
if not os.path.exists(model) or os.path.getsize(model) < 100000:
    try:
        import urllib.request
        os.makedirs(os.path.dirname(model) or ".", exist_ok=True)
        tmp = model + ".part"
        urllib.request.urlretrieve(URL, tmp)
        os.replace(tmp, model)
    except Exception:
        out({"error": "model_unavailable"})
try:
    lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=mpp.BaseOptions(model_asset_path=model), output_face_blendshapes=True, num_faces=1))
except Exception:
    out({"error": "model_load_failed"})
cap = cv2.VideoCapture(path)
fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
if not cap.isOpened() or b <= a:
    out({"error": "unreadable"})
acc = {"smile": [], "surprise": [], "sad": [], "anger": []}
faces = 0
for i in range(n):
    t = a + (b - a) * (i + 0.5) / n
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
    ok, fr = cap.read()
    if not ok:
        continue
    if fr.shape[1] > 640:
        s = 640.0 / fr.shape[1]
        fr = cv2.resize(fr, None, fx=s, fy=s)
    res = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)))
    if not res.face_blendshapes:
        continue
    faces += 1
    bs = {c.category_name: c.score for c in res.face_blendshapes[0]}
    g = lambda k: bs.get(k, 0.0)
    acc["smile"].append((g("mouthSmileLeft") + g("mouthSmileRight")) / 2)
    acc["surprise"].append(min(1.0, (g("jawOpen") + (g("eyeWideLeft") + g("eyeWideRight")) / 2 + g("browInnerUp")) / 2))
    acc["sad"].append(min(1.0, (g("mouthFrownLeft") + g("mouthFrownRight")) / 2 + g("browInnerUp") * 0.3))
    acc["anger"].append((g("browDownLeft") + g("browDownRight")) / 2)
m = lambda v: round(sum(v) / len(v), 3) if v else 0.0
out({"faces": faces, "samples": n, **{k: m(v) for k, v in acc.items()}})
