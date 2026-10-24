#!/usr/bin/env bash
# yt-clips installer/checker. Checks Node (>=22.18), ffmpeg, yt-dlp, and (optional) a Whisper engine; installs what is missing
# ONLY when you answer y. Works with apt (Debian/Ubuntu/VPS), Termux (pkg) and Homebrew. It never touches your data/ folder.
# NOT verified on a real VPS/Termux by the author (only syntax-checked) - report problems.
set -u
yes_no() { printf '%s [y/N] ' "$1"; read -r a || a=n; [ "$a" = y ] || [ "$a" = Y ]; }
have() { command -v "$1" >/dev/null 2>&1; }
if have pkg && [ -n "${TERMUX_VERSION:-}" -o -d /data/data/com.termux ]; then PM=termux; elif have apt-get; then PM=apt; elif have brew; then PM=brew; else PM=none; fi
SUDO=""; [ "$(id -u)" != 0 ] && have sudo && SUDO=sudo
echo "package manager: $PM"
install_pkg() { # $1=apt/brew/termux name
  case "$PM" in
    apt) $SUDO apt-get update -y && $SUDO apt-get install -y "$1" ;;
    termux) pkg install -y "$1" ;;
    brew) brew install "$1" ;;
    *) echo "  install $1 manually (no supported package manager found)"; return 1 ;;
  esac
}
ok=1
# --- Node >= 22.18 (type stripping + node:sqlite)
if have node; then
  v=$(node -p 'process.versions.node'); maj=${v%%.*}; min=${v#*.}; min=${min%%.*}
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 18 ]; }; then echo "OK   node $v"; else echo "FAIL node $v is too old (need >= 22.18)"; ok=0; fi
else echo "FAIL node missing"; ok=0; fi
if [ "$ok" = 0 ]; then
  echo "  Node 22.18+ : use https://nodejs.org (or 'nvm install 24'). Termux: 'pkg install nodejs' (check version)."
fi
# --- ffmpeg / ffprobe
if have ffmpeg && have ffprobe; then echo "OK   ffmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3)"; else
  echo "FAIL ffmpeg missing"; yes_no "install ffmpeg now?" && install_pkg ffmpeg || ok=0; fi
# --- yt-dlp (optional: YouTube download)
if have yt-dlp; then echo "OK   yt-dlp $(yt-dlp --version)"; else
  echo "WARN yt-dlp missing (only needed for YouTube/Twitch/Kick download)"
  if yes_no "install yt-dlp via pip (--user)?"; then (have pip3 && pip3 install --user -U yt-dlp) || (have pip && pip install --user -U yt-dlp) || echo "  pip not found: see https://github.com/yt-dlp/yt-dlp#installation"; fi
fi
# --- speech-to-text (optional)
if have whisper || have whisper-cli; then echo "OK   local whisper found"; else echo "WARN no local whisper. Free alternative: put a Groq key in the dashboard (Setup -> AI) - no install needed."; fi
# --- python3 + opencv (optional face tracking)
if have python3; then echo "OK   python3 (face tracking needs opencv: pip3 install --user opencv-python-headless)"; else echo "WARN python3 missing (face tracking falls back to centred crop)"; fi
echo
if have node; then (cd "$(dirname "$0")" && node --disable-warning=ExperimentalWarning src/cli.ts doctor) || ok=0; fi
[ "$ok" = 1 ] && echo "ready: npm start   (prints the dashboard URL + token)" || { echo "fix the FAIL lines above, then re-run ./install.sh"; exit 1; }
