#!/usr/bin/env bash
# One-shot, re-runnable setup: everything the project needs besides your API keys.
#   git clone https://github.com/abhikun208/Yt-clips && cd Yt-clips && sh setup.sh      (or: npm run setup)
# Installs (only what is missing): ffmpeg, python3, git/cmake/compiler, yt-dlp, edge-tts (free voices), OpenCV (face follow),
# whisper.cpp + a speech model (free offline captions/titles), creates .env with a login token. Works on Termux, Debian/Ubuntu VPS, macOS (brew).
# Never touches data/. Each step is best-effort: a failed optional step prints a WARN and the rest continues.
# Env: WHISPER_MODEL=small|base|tiny (default: small if RAM >= 4 GB, else base)
set -u
cd "$(dirname "$0")"
have() { command -v "$1" >/dev/null 2>&1; }
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then PM=termux; elif have apt-get; then PM=apt; elif have brew; then PM=brew; else PM=none; fi
SUDO=""; [ "$(id -u)" != 0 ] && have sudo && SUDO=sudo
say() { printf '\n== %s\n' "$1"; }
pm_install() { case "$PM" in apt) $SUDO apt-get install -y "$@" ;; termux) pkg install -y "$@" ;; brew) brew install "$@" ;; *) echo "WARN install manually: $*"; return 1 ;; esac; }
[ "$PM" = apt ] && $SUDO apt-get update -y >/dev/null 2>&1
[ "$PM" = termux ] && pkg update -y >/dev/null 2>&1
echo "package manager: $PM"

say "core tools"
have node    || pm_install nodejs
have git     || pm_install git
have ffmpeg  || pm_install ffmpeg
have python3 || { [ "$PM" = apt ] && pm_install python3 python3-pip || pm_install python; }
have curl    || pm_install curl
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' || echo "FAIL node >= 22.18 needed (https://nodejs.org or nvm install 24)"

pipi() { python3 -m pip install -q -U "$@" 2>/dev/null || python3 -m pip install -q -U --break-system-packages "$@" 2>/dev/null || python3 -m pip install -q -U --user "$@" 2>/dev/null; }
say "yt-dlp (YouTube download)"
have yt-dlp && echo "ok" || { pipi yt-dlp && echo installed || echo "WARN yt-dlp not installed (node src/cli.ts install-ytdlp can retry)"; }
say "edge-tts (free narration voices)"
have edge-tts && echo "ok" || { pipi edge-tts && echo installed || echo "WARN edge-tts not installed (voice-over stays off; optional)"; }
say "OpenCV (speaker-follow crop)"
python3 -c 'import cv2' 2>/dev/null && echo "ok" || { if [ "$PM" = termux ]; then pkg install -y opencv-python python-numpy 2>/dev/null || pipi opencv-python-headless; else pipi opencv-python-headless numpy; fi; python3 -c 'import cv2' 2>/dev/null && echo installed || echo "WARN OpenCV missing: face-follow falls back to centred crop (optional)"; }

say "whisper.cpp (free offline speech-to-text: real titles + word captions)"
if [ -x "$HOME/whisper.cpp/build/bin/whisper-cli" ] && ls "$HOME"/whisper.cpp/models/ggml-*.bin >/dev/null 2>&1; then echo "ok (already built)"; else
  RAM=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null || echo 4)
  M="${WHISPER_MODEL:-$([ "${RAM:-4}" -ge 4 ] && echo small || echo base)}"
  have cmake || pm_install cmake; have g++ || have clang || { [ "$PM" = apt ] && pm_install build-essential || pm_install clang make; }
  sh tools/install-whisper-cpp.sh "$M" || echo "WARN whisper.cpp install failed (send the last 20 lines); a free Groq key in the dashboard also works"
fi

say "app config"
if [ ! -f .env ]; then
  TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  printf 'YT_CLIPS_TOKEN=%s\nHOST=0.0.0.0\nPORT=8080\nAUTO_RUN=1\n' "$TOKEN" > .env; echo ".env created (login token: $TOKEN)"
else echo ".env exists (kept)"; fi
mkdir -p data assets/music assets/hooks assets/gameplay

say "check"
node --disable-warning=ExperimentalWarning src/cli.ts local-check 2>&1 | grep -E "✓|·|Machine" | head -12
node --disable-warning=ExperimentalWarning src/cli.ts doctor --check 2>&1 | tail -15
echo; echo "DONE. Start: npm start   — then only add your API keys in the dashboard (Setup)."
