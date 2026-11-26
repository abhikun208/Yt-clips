#!/usr/bin/env bash
# 24x7 runner: keeps yt-clips alive (restart on crash/exit with backoff), keeps Android awake in Termux.
# Use:  bash deploy/run-forever.sh        (stop with Ctrl+C or: pkill -f run-forever.sh)
cd "$(dirname "$0")/.." || exit 1
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock   # stops Android from freezing Termux when the screen is off
mkdir -p data; delay=3
while true; do
  started=$(date +%s)
  node --disable-warning=ExperimentalWarning src/server/main.ts >> data/server.log 2>&1
  code=$?; ran=$(( $(date +%s) - started ))
  echo "$(date -Is) yt-clips exited code=$code after ${ran}s - restarting in ${delay}s" | tee -a data/server.log
  if [ "$ran" -gt 300 ]; then delay=3; else delay=$(( delay < 60 ? delay * 2 : 60 )); fi   # crash-loop backoff, reset after a healthy run
  sleep "$delay"
done
