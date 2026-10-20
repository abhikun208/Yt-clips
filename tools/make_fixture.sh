#!/bin/sh
# Generates a deterministic synthetic test video (no real/copyrighted content): 90s, intro black+silence, 3 "energetic" speech-like bursts, outro black.
# usage: tools/make_fixture.sh out.mp4
set -e
OUT="${1:-fixture.mp4}"
ffmpeg -y -hide_banner -loglevel error \
 -f lavfi -i "color=c=black:s=640x360:r=30:d=6" \
 -f lavfi -i "testsrc2=s=640x360:r=30:d=78" \
 -f lavfi -i "color=c=black:s=640x360:r=30:d=6" \
 -f lavfi -i "anullsrc=r=44100:cl=mono:d=6" \
 -f lavfi -i "aevalsrc='0.5*sin(2*PI*220*t)*(1+sin(2*PI*3*t))/2 * (between(mod(t,26),3,14)+0.05)':s=44100:d=78" \
 -f lavfi -i "anullsrc=r=44100:cl=mono:d=6" \
 -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]" \
 -map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$OUT"
