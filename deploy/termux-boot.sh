#!/data/data/com.termux/files/usr/bin/bash
# Install Termux:Boot (F-Droid), then:  mkdir -p ~/.termux/boot && cp deploy/termux-boot.sh ~/.termux/boot/yt-clips.sh
termux-wake-lock
cd "$HOME/Yt-clips" 2>/dev/null || cd "$HOME/yt-clips" || exit 1
git pull --ff-only >/dev/null 2>&1
nohup bash deploy/run-forever.sh >/dev/null 2>&1 &
