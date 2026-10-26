#!/bin/sh
# Offline speech-to-text for captions (no API): builds whisper.cpp and downloads a model. Works on Termux (Android) and Linux.
# Usage:  sh tools/install-whisper-cpp.sh [tiny|base|small|medium]     (default: small; "base" if your phone has <4 GB RAM)
# UNVERIFIED in the build sandbox (no network there) - if a step fails, send the last 20 lines of output.
set -e
MODEL="${1:-small}"; DIR="${WHISPER_CPP_DIR:-$HOME/whisper.cpp}"
if [ -n "$PREFIX" ] && echo "$PREFIX" | grep -q termux; then pkg install -y git cmake clang make curl; else command -v cmake >/dev/null || { echo "cmake, git, g++ chahiye (apt install -y git cmake g++ make curl)"; exit 1; }; fi
[ -d "$DIR" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$DIR"
cd "$DIR"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF >/dev/null
cmake --build build -j "$(nproc 2>/dev/null || echo 2)" --config Release --target whisper-cli
BIN="$DIR/build/bin/whisper-cli"; [ -x "$BIN" ] || { echo "whisper-cli build nahi hua"; exit 1; }
MF="$DIR/models/ggml-$MODEL.bin"
[ -f "$MF" ] || curl -L --fail -o "$MF" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
BINDIR="${PREFIX:-/usr/local}/bin"; mkdir -p "$BINDIR" 2>/dev/null || true; ln -sf "$BIN" "$BINDIR/whisper-cli" 2>/dev/null || echo "PATH mein whisper-cli nahi daal paya: $BIN"
cd - >/dev/null
touch .env; grep -v '^YT_CLIPS_WHISPER_CPP_MODEL=' .env > .env.tmp || true; echo "YT_CLIPS_WHISPER_CPP_MODEL=$MF" >> .env.tmp; mv .env.tmp .env
echo "Done. Model: $MF"; echo "Check: npm run cli -- local-check   (whisper-cpp ✓ dikhna chahiye)"
