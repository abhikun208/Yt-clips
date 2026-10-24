# yt-clips — free, self-hosted video → Shorts automation

Ek lambi video (ya YouTube channel) do → ye khud best moments dhoondta hai, unhe 9:16 Shorts mein edit karta hai (captions, color, zoom, audio clean), title/description/tags/thumbnail banata hai, aur (jab aap allow karo) YouTube par unlisted upload → verify → schedule → publish karta hai. Phir views ka analytics padh kar aage ka posting time seekhta hai.

**Free hai:** koi paid API/subscription nahi. Sab kuch FFmpeg, SQLite, Node.js, YouTube ki free API quota, yt-dlp aur faster-whisper (open-source) par chalta hai. Zero npm dependencies.

## Kya automatic hai, kya aapko dena hai

| Step | Automatic? | Aapko kya dena hai |
|---|---|---|
| Video lena | Haan: file upload ya YouTube channel watch (yt-dlp) | Sirf wahi video/channel jiske rights aapke paas hain (checkbox) |
| Best moments dhoondna, intro/outro skip | Haan | — |
| Edit (crop 9:16, grade/LUT, zoom, beat+keyword punch, particles, light leak, flash cuts, jump cuts, slow-mo, progress bar, noise clean, -14 LUFS) | Haan | — |
| Captions (72 styles, Hindi/Hinglish) | Haan, transcript milte hi | Style chuno (ek baar) |
| Transcript | Haan agar faster-whisper installed; warna aap `.srt` do | — |
| Title/desc/tags/thumbnail | Haan (template; optional free LLM) | — |
| YouTube upload | Sirf jab aap allow karo | Google OAuth client (free) + `data/config.json` mein gate on |
| Public karna / schedule | Aapke config par (`autoApprove`, `publicVisibilityAllowed`) | Ye decision aapka rehta hai |
| Analytics → best time | Haan (YouTube/Instagram/Facebook/TikTok token ho to) | Platform token (optional) |
| Comments ke reply | Comments khud padhta + draft banata hai; post tabhi jab aap approve karo + `commentsAutoPost` on karo | Ek baar `youtube-connect-full` (Desktop-app OAuth client) |

Safety: publish, public visibility aur comment-posting teeno **default OFF** hain. Inhe sirf aap server par `data/config.json` edit karke on kar sakte ho, API/env se nahi.

## Setup (naya user)

Chahiye: **Node ≥ 22.18** aur **ffmpeg** (libass wala, normal build mein hota hai). Optional: `yt-dlp` (YouTube se download), `faster-whisper` (transcript), python3+opencv (face tracking), Noto fonts (Hindi captions).

```bash
git clone https://github.com/abhikun208/yt-clips && cd yt-clips
npm test            # "fail 0" aana chahiye
npm run doctor      # kya installed hai, kya missing
npm start           # UI: http://127.0.0.1:8080
```
Browser mein "Video add karo" → file upload (rights checkbox) ya YouTube channel URL. Clips `data/edited_shorts/`, manifest `data/manifests/`, thumbnail `data/thumbnails/`, captions `data/captions/` mein aate hain.

Bina UI ke: `npm run cli -- add video.mp4 --authorized` → `npm run cli -- run` → `npm run cli -- status`. Saari commands: `npm run cli -- help`.

### Dashboard (browser)
Tabs: **Home** (live pipeline, setup checklist, video upload, channels auto-watch), **Clips** (review inbox: Approve/Reject, title/description/tags edit, thumbnail frame, re-render with another caption style/effects as a NEW version, ZIP export, Share to Instagram/TikTok/Facebook from phone), **Publish** (YouTube connect, upload queue, comments), **Insights** (analytics, best posting time), **Studio** (72 caption styles, transcript editor), **Setup** (Autopilot, AI, social login).

### Captions/titles/AI — key ke saath ya bina key
- **Bina kisi key ke:** local engine transcript se keyphrases, hook line, title, description, tags banata hai aur clip ke edges sentence par kaat-ta hai. Par captions ke liye speech-to-text chahiye (neeche).
- **Free Groq key** (console.groq.com → API Keys → `gsk_...`): Setup tab → AI → provider "Groq" → key → "Save → speech-to-text" aur "Save → titles + ranking". Free limits Groq ke hain (docs 2026-10-23: whisper-turbo ~20 req/min, 7.2K audio-sec/ghanta; badal sakte hain).
- **Bilkul key-free (local):** apni machine par Ollama/LM Studio chalao → Setup → AI → preset "Ollama" (base `http://127.0.0.1:11434/v1`, key khali) → titles + AI clip-ranking local model se. Local speech-to-text: `pip install faster-whisper` ya koi OpenAI-compatible local STT server (base URL localhost ho to key nahi lagti).
- **Fallback chain:** Primary + 2 fallback providers (Groq → Gemini → OpenRouter → Mistral ya local). Jo pehle chale. Presets ke base URLs unki docs se hain par maine kisi ko live call nahi kiya (sirf Groq docs padhe).
- LLM clip timestamps nahi banata: sirf hamare candidates ko score karta hai (0.7 local + 0.3 AI).

### Social accounts login — ID/password kyun nahi, kya hai
Instagram/TikTok/YouTube ka ID-password kisi bot ko dena unki terms ke against hai (account ban, 2FA, password leak). Isliye official "Login with…" (OAuth): har platform par ek baar free developer app banao → Setup tab mein ID/Secret → Login → "Allow". Abhi ye logins **analytics** ke liye hain. **YouTube upload** bana hai. **Instagram/TikTok/Facebook upload adapters nahi bane** (unki app review/credentials chahiye) — unke liye Clips → **Share** (phone ka share sheet) ya **Export ZIP** (mp4 + thumbnail + srt + title/description/tags) use karo. TikTok/Meta redirect URI mein https maang sakte hain.

### Full automation (Autopilot)
Worker har ~30 sec: channels poll → analyze → clips → edit (LUT, grain, particles, light leak, flash cuts, jump cuts, slow-mo, beat/keyword zoom, progress bar, captions) → QC → title/thumbnail → [aapka review, optional] → unlisted upload → verify → schedule → publish → analytics → comments.
- UI: Setup → Autopilot → "Auto-queue uploads" (+ "Pehle meri review").
- Safety gates sirf server par (UI/API se nahi): `npm run cli -- autopilot on --publish --yes` (private/unlisted tak) · `npm run cli -- autopilot on --review --publish --approve --public --yes` (auto public, aapke review ke baad) · `npm run cli -- autopilot off`.
- Source channel add karne ke baad kuch nahi karna: loop khud naye uploads dhoondh kar process karta rehta hai (yt-dlp chahiye).

### Optional installs (free)
- Transcript (alternative to Groq): `pip install faster-whisper` (PC/VPS). Ya apna `.srt/.vtt/.json` video ke saath rakho.
- YouTube download: `pip install yt-dlp`.
- Hindi fonts: `sudo apt install fonts-noto-core`.

### Server par 24x7 chalana
Docker: `cp .env.example .env` → `YT_CLIPS_TOKEN` set karo (`openssl rand -hex 24`) → `docker compose up -d --build`. VPS: `sudo bash deploy/install-vps.sh --with-ytdlp`. PaaS: Dockerfile + `/data` persistent volume. Poori detail: [DEPLOY.md](DEPLOY.md). Public host par token zaroori hai.

### YouTube par publish (free, ek baar ka setup)
1. Google Cloud Console → naya project → "YouTube Data API v3" enable → OAuth client banao (type **TVs and Limited Input devices**). Free quota 10,000 units/din milti hai.
2. `.env` mein `YT_OAUTH_CLIENT_ID`, `YT_OAUTH_CLIENT_SECRET` (aur `YT_CLIPS_SECRET_KEY` taaki token encrypted rahe).
3. `npm run cli -- youtube-connect` → jo code dikhe use google.com/device par daalo.
4. `data/config.json`: `{"gates":{"publishEnabled":true}}` → sirf **unlisted** upload hoga.
5. Test: `npm run cli -- queue <clipId> youtube_shorts` phir `npm run cli -- advance <uploadId>` baar baar.
6. Full auto: `{"automation":{"autoQueue":true,"autoApprove":true},"gates":{"publishEnabled":true,"publicVisibilityAllowed":true}}`. Phir server khud queue → upload → verify → schedule karta hai (`npm run cli -- tick` se ek cycle haath se).

Dhyan: Google naye/unverified API projects par videos ki visibility par pabandi laga sakta hai. Pehle ek clip unlisted test karo.

### Analytics (best posting time)
`npm run cli -- platforms` dikhata hai kaun connected hai. YouTube `youtube-connect` se milta hai. Instagram/Facebook/TikTok ke liye aapka khud ka access token: `echo TOKEN | npm run cli -- set-token instagram`. Ya CSV: `npm run cli -- analytics-import file.csv` (columns `published_at,views`). Worker har 6 ghante khud collect karta hai; `npm run cli -- plan 3` agle slots dikhata hai (data kam ho to baseline hours).

## Common problems
- `EADDRINUSE: address already in use ...:8080` → pehle se koi server (ya aapka purana `npm start`) chal raha hai. Naya port lo: `PORT=8090 npm start`, ya purana band karo (Termux mein `pkill node`).
- Termux/Android par bhi chalta hai (Node ≥ 22.18, `pkg install ffmpeg`); heavy rendering phone par dheere hoga, `edit.preset`/`glow`/`zoom` kam karke tez karo.
- `yt-dlp`/`whisper` WARN normal hai: local video + `.srt` se kaam chalta hai.

## Sach: kya verified hai, kya nahi
Verified (tests + real ffmpeg/process runs): ingest, analysis, clipping, rendering, captions, QC, state machine, server/auth, automation loop. **Fake-tested only** (asli account par kabhi nahi chala): YouTube/Instagram/Facebook/TikTok API calls. **Unverified:** Docker build, systemd, asli yt-dlp/faster-whisper. Pura hisaab: [PROGRESS.md](PROGRESS.md) aur [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md).

Rights: sirf apni ya authorized content use karo. Views/ranking ki koi guarantee nahi.
