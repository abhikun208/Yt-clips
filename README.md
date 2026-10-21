# yt-clips
Self-hosted pipeline: source video → whole-timeline analysis → ranked clips → non-destructive vertical edit (separate folder) → QC → Hinglish metadata + thumbnail → gated publish state machine.

Runtime has **zero npm dependencies** (Node ≥ 22.18, built-in `node:sqlite`/`node:test`) plus `ffmpeg`/`ffprobe`. Optional: python3+opencv (face tracking), yt-dlp, whisper (not wired yet; use sidecar `.srt`).

```
npm run doctor
npm run cli -- add /path/video.mp4 --authorized
npm run cli -- run          # analyze -> render -> metadata (resumable job queue)
npm run cli -- status
npm test
```
Web UI + API + worker: `npm start` (needs `YT_CLIPS_TOKEN` when not on localhost). Deploy anywhere: see `DEPLOY.md` (Docker / VPS / PaaS). Caption presets: `npm run cli -- presets`.

Outputs: `data/edited_shorts/*.mp4`, `data/manifests/*.json` (treatments + QC), `data/thumbnails/*.jpg`. Publishing/comments are OFF by default (see `MASTER_RUN_PROMPT.md`). Progress ledger: `PROGRESS.md`.
