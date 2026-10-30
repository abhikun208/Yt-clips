#!/bin/sh
# Offline speech-to-text for captions (no API): builds whisper.cpp and downloads a model. Works on Termux (Android) and Linux.
# Usage:  sh tools/install-whisper-cpp.sh [tiny|base|small|medium]     (default: small; "base" if your phone has <4 GB RAM)
# UNVERIFIED in the build sandbox (no network there) - if a step fails, send the last 20 lines of output.
set -e
MODEL="${1:-small}"; DIR="${WHISPER_CPP_DIR:-$HOME/whisper.cpp}"
if [ -n "$PREFIX" ] && echo "$PREFIX" | grep -q termux; then pkg install -y git cmake clang make curl; else command -v cmake >/dev/null || { echo "cmake, git, g++ chahiye (apt install -y git cmake g++ make curl)"; exit 1; }; fi
WHISPER_CPP_TAG="${WHISPER_CPP_TAG:-v1.9.5}"   # pinned: a moving master could break the build on your server
[ -d "$DIR" ] || git clone --depth 1 --branch "$WHISPER_CPP_TAG" https://github.com/ggml-org/whisper.cpp "$DIR" || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$DIR"
cd "$DIR"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF >/dev/null
cmake --build build -j "$(nproc 2>/dev/null || echo 2)" --config Release --target whisper-cli
BIN="$DIR/build/bin/whisper-cli"; [ -x "$BIN" ] || { echo "whisper-cli build nahi hua"; exit 1; }
MF="$DIR/models/ggml-$MODEL.bin"
if [ ! -f "$MF" ]; then curl -L --fail -o "$MF.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin" && [ "$(wc -c < "$MF.part")" -gt 30000000 ] && mv "$MF.part" "$MF" || { rm -f "$MF.part"; echo "model download fail/chhota file"; exit 1; }; fi
BINDIR="${PREFIX:-/usr/local}/bin"; mkdir -p "$BINDIR" 2>/dev/null || true; ln -sf "$BIN" "$BINDIR/whisper-cli" 2>/dev/null || echo "PATH mein whisper-cli nahi daal paya: $BIN"
cd - >/dev/null
touch .env; grep -v '^YT_CLIPS_WHISPER_CPP_MODEL=' .env > .env.tmp || true; echo "YT_CLIPS_WHISPER_CPP_MODEL=$MF" >> .env.tmp; mv .env.tmp .env; chmod 600 .env 2>/dev/null || true
echo "Done. Model: $MF"; echo "Check: npm run cli -- local-check   (whisper-cpp ✓ dikhna chahiye)"
