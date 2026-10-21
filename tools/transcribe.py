#!/usr/bin/env python3
"""Speech-to-text helper using faster-whisper (CPU, int8). Usage: transcribe.py <audio.wav> [model=small] [language=auto]
Prints ONE JSON object to stdout: {"language": str, "segments": [{"start","end","text","words":[{"start","end","word"}]}]}
or {"error": "..."} with a non-zero exit code. The model is downloaded on first use (needs network once)."""
import json, sys

def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage"})); return 2
    audio = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "small"
    lang = sys.argv[3] if len(sys.argv) > 3 else "auto"
    try:
        from faster_whisper import WhisperModel
    except Exception:
        print(json.dumps({"error": "faster_whisper_missing"})); return 3
    try:
        m = WhisperModel(model, device="cpu", compute_type="int8")
        segs, info = m.transcribe(audio, word_timestamps=True, vad_filter=True, language=None if lang == "auto" else lang)
        out = []
        for s in segs:
            out.append({"start": float(s.start), "end": float(s.end), "text": s.text.strip(),
                        "words": [{"start": float(w.start), "end": float(w.end), "word": w.word.strip()} for w in (s.words or [])]})
        print(json.dumps({"language": info.language, "segments": out}, ensure_ascii=False)); return 0
    except Exception as e:  # model download/network/memory problems
        print(json.dumps({"error": f"transcribe_failed: {type(e).__name__}: {e}"[:300]})); return 4

if __name__ == "__main__":
    sys.exit(main())
