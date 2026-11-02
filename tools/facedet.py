"""Shared face detector for face_center.py / face_track.py. detect(frame_bgr) -> [(x, y, w, h)] in that frame's pixels.
Order: (1) OpenCV Haar cascade (OpenCV 4.x, offline, ships with the wheel/pkg), (2) YuNet via cv2.FaceDetectorYN (works on OpenCV 5 where the
cascade API is gone; the 230 KB model is downloaded once from the OpenCV zoo into data/models). Returns None when neither is usable."""
import os, sys

URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"

def _model_path():
    d = os.environ.get("YT_CLIPS_DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
    return os.path.join(d, "models", "face_detection_yunet_2023mar.onnx")

def load(cv2):
    try:
        c = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        if not c.empty():
            def haar(fr):
                g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
                return [tuple(int(v) for v in f) for f in c.detectMultiScale(g, 1.2, 5, minSize=(30, 30))]
            return haar
    except Exception:
        pass
    if not hasattr(cv2, "FaceDetectorYN"):
        return None
    p = _model_path()
    if not os.path.exists(p) or os.path.getsize(p) < 50000:
        try:
            import urllib.request
            os.makedirs(os.path.dirname(p), exist_ok=True)
            urllib.request.urlretrieve(URL, p + ".part")
            os.replace(p + ".part", p)
        except Exception:
            return None
    try:
        det = cv2.FaceDetectorYN.create(p, "", (320, 320), 0.6, 0.3, 5000)
    except Exception:
        return None
    def yunet(fr):
        h, w = fr.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(fr)
        return [] if faces is None else [(int(f[0]), int(f[1]), int(f[2]), int(f[3])) for f in faces]
    return yunet
