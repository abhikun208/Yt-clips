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
**Production = Docker Compose** (dependencies image me pehle se: ffmpeg, yt-dlp, OpenCV, faster-whisper + `small` model; runtime pe koi pip install nahi). `setup.sh` sirf dev/Termux/seedhe VPS ke liye hai. `docker-compose.yml` me `WITH_YTDLP=1` aur `WITH_WHISPER=1` default on hain (build bada hota hai: `WITH_WHISPER=0` se hatao). Docker/compose maine yahan build karke nahi dekha (sandbox me daemon nahi): pehla `docker compose up -d --build` tum chalao aur `docker compose logs -f` bhejo.

## 2) VPS bina Docker (Ubuntu/Debian)
```bash
sudo bash deploy/install-vps.sh --with-ytdlp          # --with-whisper bhi de sakte ho
sudo systemctl status yt-clips ; journalctl -u yt-clips -f
```
HTTPS ke liye `deploy/Caddyfile` (domain badlo) — Caddy khud certificate leta hai. Token `/etc/yt-clips.env` mein.

## 3a) Kisi bhi cloud par (Docker image sab jagah chalti hai)
Fly.io: `fly.toml` (volume + token commands upar likhe hain). Render / Railway / Koyeb / Cloud Run / VPS: `Dockerfile` use karo, PORT apne aap padhta hai.

## 3a) Render / Railway / Replit (ready-made files)
- **Render:** New > Blueprint > repo (`render.yaml`). Free 512MB plan video render nahi kar sakta, `starter` use karo.
- **Railway:** repo connect (`railway.json` Dockerfile use karta hai); Volume `/data` par mount karo.
- **Replit:** import repo (`.replit` + `replit.nix`: Node 22, ffmpeg, yt-dlp). Run dabao.
- **Token:** `YT_CLIPS_TOKEN` na do to server khud ek token banata hai (data folder mein `auto-token.txt`) aur **deploy logs mein "LOGIN TOKEN" line** mein dikhata hai. HOST/PORT apne aap sahi ho jate hain.
- Volume root-owned ho to `deploy/docker-entrypoint.sh` /data ka owner theek karta hai.
- UNVERIFIED: asli Render/Railway/Replit deploy (sandbox mein Docker/internet nahi). Boot test (PORT set, token nahi) pass hai.

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

## Logins that never expire (read once)
- Logins are official OAuth refresh tokens (no passwords, no browser cookies). The server refreshes them by itself and alerts you on Telegram only if one really died.
- **YouTube: publish the Google OAuth app ("OAuth consent screen" → *Publish app* / In production).** An app left in *Testing* makes Google expire the refresh token after 7 days - the #1 reason "login keeps expiring".
- Uploads are paced for account safety: max 3/day per channel, 180 min apart, quiet hours 00-06, random jitter, platforms staggered; everything goes through the official upload APIs from one stable server IP (no scripted logins, so nothing looks like a bot).
- Set `YT_CLIPS_SECRET_KEY` so saved tokens are encrypted on disk.
