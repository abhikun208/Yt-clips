#!/bin/sh
# Mounted volumes (Railway/Render/Fly) are root-owned: fix /data, then drop to the unprivileged user.
set -e
D="${YT_CLIPS_DATA_DIR:-/data}"
mkdir -p "$D" 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$D" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
