# yt-clips

Lambi video ya live stream do → ye khud best moments dhoondta hai, unhe 9:16 Shorts me edit karta hai, title/tags/thumbnail banata hai, aur YouTube / Facebook / Instagram (aur baaki platforms) par post karta hai. Free aur self-hosted: Node.js + FFmpeg + SQLite, **zero npm dependencies**.

> **Sach:** pipeline ke tests (real ffmpeg + fake servers) pass hain. Asli Facebook / Instagram / YouTube account par posting abhi **UNVERIFIED** hai (sirf fake APIs par test hui). Pehli real run phone/server par aapko hi karni hai. Details: [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md).

## Kya karta hai

| Kaam | Kaise |
|---|---|
| Source lena | file upload, YouTube/Kick/Twitch URL (yt-dlp), channel watch, live stream capture |
| Best moments | audio/scene/motion/transcript (Hindi, Hinglish) events → setup→payoff pattern → score + tier. Sirf loudness wale moment kabhi top tier nahi paate |
| Edit | 9:16 crop/fit, face-follow, gameplay+facecam, 2-3 logon ka stack layout, captions (72 styles), zoom, jump cuts, audio clean (-14 LUFS), content-type ke hisaab se style |
| Dubbing | English video → Hindi awaaz (edge-tts + LLM key chahiye) |
| Metadata | title, description, tags, hashtags, thumbnail (AI key ke saath ya bina) |
| Publish | unlisted upload → verify → schedule → public. Har channel ki alag policy |
| Kis channel par kya | har source ke liye permission: kin channels par jaye, ya sirf apne channel par |
| Audit | Home tab ka "Publishing audit" card batata hai ki kuch public kyun nahi ho raha (BLOCKED + fix) |
| Seekhna | analytics se best posting time, title A/B |

## Shuru karo (2 minute)

Chahiye: **Node ≥ 22.18**, **ffmpeg**.

```bash
git clone https://github.com/abhikun208/Yt-clips && cd Yt-clips
sh setup.sh          # ffmpeg, yt-dlp, whisper, edge-tts, .env sab install (Termux/VPS/Mac)
npm start            # dashboard: http://127.0.0.1:8080
```

Windows: `npm run setup:windows`. Baad me update: `git pull && npm start`.
Sahi chal raha hai ya nahi: `npm run doctor`. Tests: `npm test` (`fail 0` aana chahiye).

## Asli posting on karna (sirf owner, `.env` me)

Publishing API/dashboard se kabhi on nahi hoti. `.env` me ye likho aur restart karo:

```
PUBLISH_MODE=PUBLIC     # PRIVATE = kabhi public nahi · likha nahi = DRY_RUN (kuch post nahi hota)
AUTO_APPROVE=true       # verified clip bina Approve dabaye schedule/public ho jaye
```

Phir Home → **Publishing audit** dekho: jo BLOCKED hai uske saath fix likha hota hai.

**YouTube:** Google Cloud → YouTube Data API v3 → OAuth client → `.env` me `YT_OAUTH_CLIENT_ID`, `YT_OAUTH_CLIENT_SECRET` (+ `YT_CLIPS_SECRET_KEY` agar token ki key khud rakhni ho) → dashboard me Connect. OAuth app ko **Production** mode me rakho, warna token 7 din me mar jata hai. Naye/unaudited API project ke uploads Google private rakh sakta hai: [docs/YOUTUBE_AUDIT.md](docs/YOUTUBE_AUDIT.md). Free quota 10,000 units/din.
**Facebook / Instagram:** Setup → Accounts me Meta login → Page chuno. Instagram Reels ko public https URL chahiye: `pkg install cloudflared` (tunnel khud start hota hai) ya `PUBLIC_URL=https://...`.
**Baaki:** Telegram/Discord/Mastodon/Bluesky token se; jahan official API nahi, wahan "Manual post tasks" (file + caption ready, aap post karke Posted dabao). Kisi site ka ID/password bot ko nahi diya jata.

## Dashboard

8 tabs: **Home** (pipeline, audit, moments) · **Sources** (video add, channels, upload permission) · **Clips** (review, edit, re-render) · **Studio** · **Queue** (upload, distribution, comments) · **Accounts** · **Analytics** · **Settings** (AI keys, config).

CLI (bina UI): `npm run cli -- add video.mp4 --authorized` → `npm run cli -- run` → `npm run cli -- status`. Saari commands: `npm run cli -- help`.

## AI keys (optional)

Bina key ke local engine title/tags banata hai. Behtar quality ke liye `.env` me koi bhi free key: `GROQ_API_KEY` (speech-to-text + titles), GEMINI, OPENROUTER, MISTRAL aadi (poori list `.env.ai.example` me). `npm run cli -- env-check` har key ko asli call se jaanchta hai. Dubbing ke liye `edge-tts` + ek LLM key chahiye.

## 24x7 chalana

- **Phone (Termux):** `npm run forever` (crash par auto-restart + wake-lock). Android me Termux ki battery "Unrestricted" karo. Reboot ke baad auto-start: [DEPLOY.md](DEPLOY.md).
- **Server:** `docker compose up -d --build` ya `sudo bash deploy/install-vps.sh`. Public host par `YT_CLIPS_TOKEN` zaroori. Detail: [DEPLOY.md](DEPLOY.md).

## Common problems

- `EADDRINUSE :8080` → purana server chal raha hai: `pkill node` ya `PORT=8090 npm start`.
- Phone par render dheere hota hai: `edit.preset` / `glow` / `zoom` kam karo.
- `yt-dlp` / `whisper` WARN normal hai agar installed nahi; local video + `.srt` se kaam chalta hai.
- Kuch public nahi ho raha → Home → Publishing audit.

## Docs

[PENDING_CHECKLIST.md](PENDING_CHECKLIST.md) (kya baaki hai) · [PROGRESS.md](PROGRESS.md) (history) · [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PUBLISHING_STATE_MACHINE.md](docs/PUBLISHING_STATE_MACHINE.md) · [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) · [DEPLOY.md](DEPLOY.md)

Rights: sirf apna ya authorized content use karo. Views ki koi guarantee nahi.
