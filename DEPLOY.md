# DEPLOY.md — kahin bhi chalao (VPS / Docker / PaaS)

App ek hi Node process hai (web UI + API + background worker), **zero npm dependencies**. Chahiye: Node ≥ 22.18, `ffmpeg`, (optional) python3+opencv, yt-dlp, faster-whisper, Noto fonts.
Saari state ek folder mein: `YT_CLIPS_DATA_DIR` (SQLite + videos + outputs). Is folder ko **persistent volume** par rakho, warna restart par data jayega.

## Zaroori env (sab platforms)
| Var | Matlab |
|---|---|
| `YT_CLIPS_TOKEN` | **Zaroori** jab `HOST` 127.0.0.1 nahi hai. ≥12 chars, `openssl rand -hex 24` |
| `HOST` / `PORT` | Docker/PaaS: `HOST=0.0.0.0`, `PORT` platform deta hai |
| `YT_CLIPS_DATA_DIR` | persistent path (Docker: `/data`) |
| `AUTO_RUN=1` | background worker + YouTube polling |
| `MAX_UPLOAD_MB`, `LOOP_SECONDS`, `LOG_LEVEL` | optional |

Publishing / auto-comment / public visibility **env ya API se on nahi hote**. Sirf server par `data/config.json` edit karke (owner decision).

## 1) Docker (sabse aasaan)
```bash
cp .env.example .env && nano .env        # YT_CLIPS_TOKEN set karo
docker compose up -d --build              # UI: http://SERVER_IP:8080
```
`docker-compose.yml` mein `WITH_YTDLP=1` (YouTube download) default on hai; transcripts ke liye `WITH_WHISPER: "1"` (build bada hota hai).

## 2) VPS bina Docker (Ubuntu/Debian)
```bash
sudo bash deploy/install-vps.sh --with-ytdlp          # --with-whisper bhi de sakte ho
sudo systemctl status yt-clips ; journalctl -u yt-clips -f
```
HTTPS ke liye `deploy/Caddyfile` (domain badlo) — Caddy khud certificate leta hai. Token `/etc/yt-clips.env` mein.

## 3) PaaS (Render / Railway / Koyeb / Fly …)
Repo connect karo, **Dockerfile** se deploy karo (ya `Procfile`). Env set karo (`YT_CLIPS_TOKEN`, `HOST=0.0.0.0`), aur ek **persistent disk/volume** `/data` par mount karo (`YT_CLIPS_DATA_DIR=/data`).
Dhyan: free tiers par CPU/RAM kam hota hai: ek 40s clip render karna 2-vCPU par ~1-4 min leta hai (zoom/glow band karke tez hota hai), aur free tiers ka disk aksar ephemeral hota hai.

## Pehli baar use
1. Browser mein kholo → token se login.
2. "Video add karo" se file upload (rights checkbox zaroori) **ya** YouTube channel URL add karo (rights checkbox).
3. "Caption style" mein preview dekho, pasand wala **default** banao. (CLI: `npm run cli -- presets`, `npm run cli -- preset build-coral`)
4. Clips list mein MP4 / thumbnail / SRT / manifest (QC + treatments) dikhte hain.

## Captions ke liye transcript
Teen raaste: (a) faster-whisper install (auto), (b) `YT_CLIPS_STT_CMD` se apna engine, (c) UI/API se `.srt/.vtt/.json` bhejo (`POST /api/transcript?video=ID&format=srt`). Bina transcript ke sirf title overlay banega — captions invent nahi hote.
Hindi/Indian scripts ke liye `fonts-noto-core` zaroori hai (Dockerfile/installer mein hai). Font na mile to manifest mein warning aati hai.

## Health & ops
`GET /healthz` (no auth, koi secret nahi). Logs JSON stdout par (tokens redacted). Graceful stop: SIGTERM par naya kaam nahi uthata, chalta job lease ke through restart par resume hota hai.
Backup: sirf `YT_CLIPS_DATA_DIR` copy karo (SQLite WAL ke saath server band karke ya `sqlite3 .backup`).

## Verification status (sach)
- VERIFIED (tests): process boot/SIGTERM, token guard, auth/CSRF/rate-limit, upload→pipeline→QC, range streaming, path traversal safe, config whitelist.
- NOT VERIFIED yet (dev sandbox mein Docker daemon/internet nahi tha): `docker build`, systemd unit, `install-vps.sh`, PaaS deploys, asli yt-dlp aur faster-whisper models. Pehli baar chalate waqt ye dhyan se dekhna.
