# yt-clips — self-hosted pipeline + web UI. Build:  docker build -t yt-clips .
# Optional build args: --build-arg WITH_YTDLP=1 (YouTube download)  --build-arg WITH_WHISPER=1 (speech-to-text, ~+700MB)
FROM node:22-bookworm-slim
ARG WITH_YTDLP=1
ARG WITH_WHISPER=0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip python3-opencv fontconfig fonts-noto-core fonts-noto-ui-core fonts-dejavu-core fonts-freefont-ttf \
      ca-certificates tini curl \
 && if [ "$WITH_YTDLP" = "1" ]; then pip install --no-cache-dir --break-system-packages yt-dlp; fi \
 && if [ "$WITH_WHISPER" = "1" ]; then pip install --no-cache-dir --break-system-packages faster-whisper; fi \
 && fc-cache -f && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY assets ./assets
COPY MASTER_RUN_PROMPT.md PROGRESS.md README.md ./
# zero runtime npm dependencies, nothing to `npm install`
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 YT_CLIPS_DATA_DIR=/data AUTO_RUN=1
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini","--"]
CMD ["node","--disable-warning=ExperimentalWarning","src/server/main.ts"]
