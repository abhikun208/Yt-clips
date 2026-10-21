#!/usr/bin/env bash
# Ubuntu/Debian VPS installer (run as root). NOT tested on a real VPS from the dev sandbox — read it before running.
# usage: sudo bash deploy/install-vps.sh [--with-ytdlp] [--with-whisper]
set -euo pipefail
WITH_YTDLP=0; WITH_WHISPER=0
for a in "$@"; do case "$a" in --with-ytdlp) WITH_YTDLP=1;; --with-whisper) WITH_WHISPER=1;; esac; done
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
apt-get update
apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-opencv fontconfig fonts-noto-core fonts-dejavu-core fonts-freefont-ttf curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
[ "$WITH_YTDLP" = 1 ] && pip install --break-system-packages yt-dlp
[ "$WITH_WHISPER" = 1 ] && pip install --break-system-packages faster-whisper
id ytclips >/dev/null 2>&1 || useradd --system --home /opt/yt-clips --shell /usr/sbin/nologin ytclips
mkdir -p /opt/yt-clips /var/lib/yt-clips
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ "$SRC" = /opt/yt-clips ] || cp -a "$SRC/." /opt/yt-clips/
chown -R ytclips:ytclips /opt/yt-clips /var/lib/yt-clips
if [ ! -f /etc/yt-clips.env ]; then
  TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'YT_CLIPS_TOKEN=%s\nHOST=127.0.0.1\nPORT=8080\nYT_CLIPS_DATA_DIR=/var/lib/yt-clips\nAUTO_RUN=1\n' "$TOKEN" > /etc/yt-clips.env
  chmod 600 /etc/yt-clips.env; echo "Generated token saved in /etc/yt-clips.env"
fi
cp /opt/yt-clips/deploy/yt-clips.service /etc/systemd/system/yt-clips.service
systemctl daemon-reload && systemctl enable --now yt-clips
sleep 2; curl -fsS http://127.0.0.1:8080/healthz && echo && echo "OK. Put Caddy/nginx in front for HTTPS (deploy/Caddyfile)."
