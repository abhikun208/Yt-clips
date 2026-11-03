#!/usr/bin/env python3
"""Forced alignment with stable-ts (optional). Usage: align.py <audio.wav> <lang> '<json [{start,end,text}]>'
Prints {"segments":[{"start","end","text","words":[...]}]} or {"error": ...}. Needs `pip install stable-ts` and a whisper model (downloaded on first use)."""
import json, sys
def main() -> int:
    try:
        import stable_whisper
        audio, lang, cues = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
        text = "\n".join(c["text"] for c in cues)
        model = stable_whisper.load_faster_whisper("small") if hasattr(stable_whisper, "load_faster_whisper") else stable_whisper.load_model("small")
        res = model.align(audio, text, language=None if lang == "auto" else lang)
        segs = [{"start": float(s.start), "end": float(s.end), "text": s.text.strip(), "words": [{"start": float(w.start), "end": float(w.end), "word": w.word.strip()} for w in s.words]} for s in res.segments]
        print(json.dumps({"segments": segs}, ensure_ascii=False)); return 0
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"[:300]})); return 4
if __name__ == "__main__":
    sys.exit(main())
