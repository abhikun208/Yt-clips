# PROGRESS.md — persistent ledger (kisi bhi AI/session ko yahin se resume karna hai)

> Rule: sirf wahi "DONE" jo code + test/verify ho chuka hai. Baaki sab PARTIAL / TODO / BLOCKED.
> Last updated: 2026-10-24 (session 5, 122/122 tests). Audit: fresh `git clone` of main -> `npm test` 80/80.

## Resume kaise karein
1. `Prompt` file = original owner requirements (Hinglish). `BRAIN.md` = architecture + decisions.
2. `npm run typecheck && npm test` chalao, phir neeche "NEXT STEP" se aage badho.
3. Har NEXT STEP item: implement -> test -> `npm test` (fail 0) -> PROGRESS.md update -> commit+push `main`. Item tabhi DONE jab test pass ho; fake server se hua to "fake-tested" likho. Ant mein `git status -sb` = `main...origin/main`.
4. Guardrails: gates (`publishEnabled`, `publicVisibilityAllowed`, `commentsAutoPost`) sirf owner `data/config.json` mein badle (API/env se kabhi nahi); migrations additive; secrets logs/API mein nahi; owner ko Hinglish mein reply.
5. Runtime dependencies ZERO (Node >=22.18, `node:sqlite`, `node:test`). Dev: typescript, @types/node (is sandbox mein npm registry blocked tha, typecheck global `tsc` se hota hai).

## Environment facts (verified)
- Node v22.22, ffmpeg/ffprobe 6.1.1 (libx264, aac, subtitles/libass, loudnorm, zoompan, scdet, silencedetect), python3 + opencv (face helper optional).
- Owner's own device (Termux/Android) reported `npm run doctor`: Node v26.4.0, ffmpeg 9.0.2 OK. Full `npm test` on that device NOT yet reported.
- NOT available in the dev sandbox: yt-dlp, whisper/whisper.cpp, npm registry (403). Isliye: YouTube download aur speech-to-text optional adapters hain; sidecar `.srt/.vtt/.json` transcript supported.

## Status (verified = test or real run)
| Area | Status | Evidence |
|---|---|---|
| Config + safety gates (publish/comments/public all OFF by default) | DONE | test/core.test.ts |
| SQLite store, additive migrations, persistent job queue (lease, expiry reclaim, backoff+jitter, DEAD) | DONE | test/core.test.ts |
| Local ingest, fingerprint dedup, corrupt/unsupported rejected, original untouched | DONE | test/e2e.test.ts |
| Full-timeline analysis + intro/outro detection (overridable) + resumable checkpoint | DONE | analysis + e2e tests; real 90s fixture: intro 6.03s, outro 83.82s |
| Candidate ranking, NMS overlap, pause snapping, stable dedup fingerprints, late-moment coverage | DONE (heuristic scoring) | test/analysis.test.ts |
| Editing engine -> separate `edited_shorts`, raw clip kept, manifest, measured ffprobe/ebur128 QC | DONE | real render 1080x1920 h264/aac -14.1 LUFS; frames inspected |
| Thumbnail (validated 1280x720, rejects flat images) | DONE | e2e |
| Metadata (Hinglish template, no invented links) | DONE (template only) | test/publish.test.ts |
| Scheduler (caps, min gap, quiet hours, jitter, measured vs baseline) | DONE (logic) | test/publish.test.ts |
| Upload state machine, unlisted-first, remote verify, idempotency, retry, gates enforced | DONE with DryRunAdapter | test/publish.test.ts |
| Comments: classify, PII/spam never answered, drafts only, posting needs opt-in + approval | DONE (posting later added in session 3, see below) | test/publish.test.ts |
| Job worker (analyze->render->meta), restart is a no-op, never uploads by itself | DONE | e2e test 2 |
| CLI + doctor | DONE | `npm run doctor` |
| Reference research + honest matrix | DONE | docs/FEATURE_MATRIX.md |

### Added in session 2 (2026-10-21/22)
| Area | Status | Evidence |
|---|---|---|
| Caption engine: 72 original presets (12 styles x 6 palettes), 5 modes (highlight/build/one-word/karaoke/typewriter), emphasis words, Hindi + 9 Indian scripts font selection with warning when no font | DONE | test/captions.test.ts (every preset builds valid ASS; real libass burn-in; frames inspected visually) |
| Real per-word timing used when STT provides it; otherwise approximate (manifest says which) | DONE | captions tests, adapters test |
| SRT/VTT export per clip (`data/captions/`) | DONE | captions test |
| Web UI + HTTP API + background daemon (`npm start`): token auth, cookie+CSRF header, brute-force limit, streaming upload, Range file serving, preset previews, config whitelist (gates NOT writable), graceful SIGTERM | DONE | test/server.test.ts, test/process.test.ts (real process) |
| YouTube source adapter (yt-dlp): authorized channels/playlists/videos only, new uploads + backlog, bounded per poll, retry, skip too-long | DONE as adapter; tested with a FAKE yt-dlp | test/adapters.test.ts |
| STT adapter (faster-whisper helper or `YT_CLIPS_STT_CMD`), non-fatal on failure | DONE as adapter; tested with a FAKE engine | test/adapters.test.ts |
| Re-analysis never duplicates rendered clips | DONE | test/e2e.test.ts |
| Deploy files: Dockerfile, compose, systemd unit, install script, Caddyfile, Procfile, .env.example, DEPLOY.md | WRITTEN, **NOT BUILT/RUN here** (no Docker daemon, no registry/apt access in the sandbox). `bash -n` syntax check only | DEPLOY.md |

### Added in session 3 (2026-10-22)
| Area | Status | Evidence |
|---|---|---|
| YouTube adapter: Google device-flow OAuth (scope `youtube`), encrypted refresh-token store (AES-256-GCM via `YT_CLIPS_SECRET_KEY`, else 0600 plaintext), resumable chunked upload (crash-safe session persistence, 5xx retry, status-query resume, 404 restart, no duplicate uploads), remote verify (waits while processing), thumbnail (best-effort), publish/schedule (merges existing status first), per-Pacific-day quota accounting | DONE; tested ONLY against a FAKE Google server written from the official docs. **Never run against real Google.** | test/youtube.test.ts (9), test/fakeGoogle.ts |
| Upload API/CLI: queue, advance, list, youtube connect/poll/status; gates still enforced and NOT settable via API | DONE | test/publishwire.test.ts |
| Analytics CSV import (owner-supplied; needs time-of-day + tz) -> measured posting hours for the scheduler (`/api/schedule`, `npm run cli plan`) | DONE (manual import). Automatic pull from YouTube Analytics API: NOT implemented | publishwire tests |
| Beat effects: punch-zoom (+6%) at audio-energy peaks, recorded in manifest | DONE (graph + real ffmpeg run). Not beat/BPM detection: it is loud-transient peaks | test/beats.test.ts |
| Bug fixed: zoompan changed clip duration when source fps != output fps (fps filter added before zoompan) | FIXED | beats test |
| Transcript word editor API (GET cues, POST edits -> `.edited.json`, timing preserved, original untouched) | DONE (API + UI panel) | test/editor.test.ts |
| Optional LLM metadata (OpenAI-compatible, env `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`), validated, template fallback on any failure | DONE; tested with fake responses only | test/editor.test.ts |
| Analytics for ALL platforms: providers for YouTube (videos.list statistics), Instagram (Graph media insights), Facebook (video_insights total_video_views), TikTok (/v2/video/query/); snapshots table; collector reads only PUBLISHED uploads; per-platform failure isolation; `/api/analytics`, `/api/platforms`, `/api/platforms/:p/token`, CLI `analytics-collect`/`platforms`/`set-token`; auto-collect every `analytics.pollMinutes` (360) in the worker loop | DONE; endpoints/metrics taken from official docs (fetched 2026-10-22) but tested ONLY against fake servers. Tokens for IG/FB/TikTok are owner-supplied (no OAuth/refresh flow for them yet) | test/analytics.test.ts |
| Autonomous loop (`automationTick`, runs in the worker cycle; CLI `tick`): auto-queue QC-passed clips with metadata -> upload unlisted -> verify -> (owner `automation.autoApprove`) schedule at planned slot -> publish. OFF by default (`automation.autoQueue=false`); every step still passes the gates | DONE; fake-Google + real ffmpeg clip. Bug found and fixed by this test: the chosen schedule time was lost at the final publish step (would have published immediately) | test/automation.test.ts |
| YouTube comments: read new comments on PUBLISHED videos (own comments dropped), classify, draft; owner approve/edit/reject; post reply only with `gates.commentsAutoPost` + approval + force-ssl scope + daily cap (20). Loopback+PKCE OAuth (`youtube-connect-full`, needs a "Desktop app" OAuth client) because the device flow cannot grant force-ssl. API `/api/comments*`, CLI `comments`, `comment-approve`, `comment-post` | DONE; fake-Google tested only. Per Google docs comments.insert lists only `youtube.force-ssl` (fetched 2026-10-22) | test/comments.test.ts |
| Pre-upload safety screen on transcript/title (block => QC_FAILED, warn => reported). Keyword heuristic only: NO vision/audio model, cannot detect nudity in pixels or copyrighted music | DONE as heuristic | test/publish.test.ts |
| Speed ramp: slow-motion window (0.7x) at the strongest audio peak (clip >= 8s), audio atempo, captions/SRT re-timed, ramped duration verified (falls back to un-ramped on any mismatch); `edit.speedRamp` default true | DONE; real ffmpeg render via CLI on a fixture: speed_ramp + beat_effects applied, QC pass, treatment coverage 0.938. Speeding up "boring parts" NOT implemented | test/ramp.test.ts + live CLI run |
| Web UI panels: YouTube connect (device code) + upload queue/advance/approve, comments approve/edit/post, analytics + schedule + token + CSV import, transcript word editor | DONE; loaded in real headless Chromium (all panels render, no JS errors); script-parse test. Clicking through each button against a real account NOT done | test/server.test.ts + manual Chromium load |

| Speech-to-text via any OpenAI-compatible API (Groq free whisper-large-v3-turbo by default): audio cut into 10-min chunks (opus/mp3/aac fallback), word timestamps, 429/5xx retry, offsets restored; key saved from the UI (encrypted when `YT_CLIPS_SECRET_KEY` set) or env | DONE; real ffmpeg + FAKE API server (Groq's real API never called). Reason added: owner's phone had no STT engine so captions/analysis were generic | test/ai.test.ts (incl. end-to-end upload -> measured captions) |
| LLM titles/description/tags/3 title variants from the real transcript (same key), template fallback | DONE; fake-tested | test/ai.test.ts |
| Social login in UI: Google client, Meta (Facebook+Instagram) and TikTok OAuth code flows, one-time state, long-lived Meta token + Page/IG discovery, TikTok auto-refresh; tokens feed the analytics providers | DONE; fake servers only. TikTok may require an https redirect URI (unverified) | test/ai.test.ts |
| Clip cards show every editing feature applied/skipped with reason; `doctor` checks ffmpeg has all needed filters/encoders and STT readiness; startup prints the URL (+ tries termux-open-url) | DONE | test/ai.test.ts, doctor |

### Added in session 5 (2026-10-24)
| Area | Status | Evidence |
|---|---|---|
| Multi-channel: `channels` table (additive migration v6, default `main`), per-channel caption preset, links, hashtags, language, platform list, facecam layout; sources/uploads/analytics carry `channel_id`; clips inherit the channel of their source (YouTube channel sources pass it to every discovered video) | DONE | test/channels.test.ts |
| Per-channel SCHEDULE: own perDayCap / minGap / quiet hours / baseline hours; best hours measured from THAT channel's analytics (>=8 rows, else all-channel evidence, else baseline); cross-channel stagger (`staggerMinutes`, default 20) so two channels never post in the same window; automation plans per channel | DONE (planner deterministic-tested; no real posting) | test/channels.test.ts |
| Schedule tab: channel cards (policy editor, platforms, next slots, YouTube connect per channel), calendar, new channel form; channel picker when adding a source/upload | DONE (HTML parses; API tested; not re-screenshotted this session) | test/dashboard.test.ts, test/channels.test.ts |
| One Google login per channel (secret `youtube-<slug>`; `main` keeps `youtube`); analytics + comments + upload use the upload's own channel token | DONE; fake-Google tested | test/automation.test.ts, comments.test.ts |
| Platform registry: YouTube (api-upload), Telegram/Discord/Mastodon (direct: staged first, ONE request at publish, crash-safe idempotent, local schedule wait, gates apply), 10 more platforms as MANUAL post tasks (file+caption+time, owner presses Posted) | DONE; direct posters FAKE-SERVER tested only | test/direct.test.ts |
| Credential vault (write-only API, validated shapes, https/host allow-list, per channel), Telegram owner notifications (clip ready / manual due / published) | DONE; fake-tested | test/direct.test.ts |
| Secrets always encrypted: key auto-generated in `data/.keys/secret.key` (0600) when `YT_CLIPS_SECRET_KEY` is unset; legacy plaintext files migrated | DONE | test/direct.test.ts |
| Hardware encoder probe (NVENC/VideoToolbox/MediaCodec, real 8-frame test encode) + automatic libx264 fallback; `resources.renderConcurrency` lanes | DONE; NO GPU in the sandbox so hardware paths were only probed (they correctly report unavailable) | test/encoder.test.ts |
| Gaming: live-chat replay + "most replayed" heatmap signals in clip scoring, gaming vocabulary (booyah, clutch, 1v4...), gaming profile, gamer-stack 9:16 layout (gameplay top / facecam bottom), Whisper language hint + Hinglish gaming prompt, Twitch/Kick VOD URLs | DONE; parsers + scoring + layout pixel-tested; real yt-dlp chat/heatmap download NEVER run | test/signals.test.ts |
| `smoke` CLI: real Groq LLM/STT call, yt-dlp metadata, YouTube login per channel, optional PRIVATE test upload | DONE (the check code is fake-endpoint tested; the OWNER must run it for the real result) | test/smoke.test.ts |
| install.sh, GitHub Actions CI, docs/YOUTUBE_AUDIT.md | DONE; install.sh syntax-checked only, CI never ran on GitHub | — |
| ID/password "login bots" for Instagram/TikTok/etc. | **DELIBERATELY NOT BUILT**: against those platforms' terms, triggers bans/2FA/captcha, cannot be tested honestly, and stores your passwords. Replaced by tokens/webhooks (Telegram/Discord/Mastodon) + manual post tasks | — |

### Added in session 4 (2026-10-23)
| Area | Status | Evidence |
|---|---|---|
| Local keyless text intelligence: sentence-aware clip edges (snap to sentence boundaries), hook/payoff scoring, keyphrase-based Hinglish/English/Hindi titles, descriptions, tags from the real transcript (template only when no speech) | DONE (heuristic, not an LLM) | test/local.test.ts |
| Extra visual treatments in the NEW `data/edited_shorts` folder (originals untouched): cinematic curve per mood or owner `.cube` LUT (`assets/luts`), film grain, drifting dust particles, animated light leak, flash transition on beat/ramp moments. All generated by ffmpeg filters (no overlay assets). Toggle: `edit.vfx.{lut,grain,particles,lightLeak,flash}` | DONE; real ffmpeg render + frame inspected + live CLI run (manifest lists each) | test/vfx.test.ts |
| Measured "visual change": 1-SSIM between the plain 9:16 reframe and the final edit, stored in each manifest (`visualChange`) next to treatment coverage (applied/21 dimensions) and `treatmentTarget` {target 0.4, met}. Live run: coverage 0.81 / 0.95, change 0.17 / 0.23 | DONE. Honest meaning: structural difference vs plain reframe, NOT a copyright-evasion claim | test/vfx.test.ts |
| Clip title overlay now uses the clip's own hook sentence in the local title engine | DONE | pipeline |
| Keyless AI: localhost/LAN OpenAI-compatible endpoints (Ollama, LM Studio, local STT) need no key; provider presets; fallback chain of 3 LLM providers (metadata tries each until one answers); LLM re-ranking of OUR candidates (blend 0.7 local + 0.3 AI, junk scores ignored, no invented clips) | DONE; fake-server tested only, no real provider called | test/llmchain.test.ts |
| Jump cuts: long silences (>=0.55s) shortened, opening 0.8s protected, <=25% of clip, A/V via select/aselect, captions re-timed and ghost words dropped, verified by duration else rendered without | DONE; real ffmpeg + real renderCandidate | test/jumpcut.test.ts |
| Animated progress bar, keyword punch-zoom (top keyphrase words with measured timing) | DONE (keyword zoom only when STT gave word timing) | test/jumpcut.test.ts, manifest |
| Review inbox backend: approve/reject/reset, metadata edit (validated), thumbnail from chosen frame, ZIP export (own zip writer, verified with python zipfile), re-render as NEW variant (_v1, _v2; raw kept; old output untouched), `automation.requireReview` + rejected never auto-queued; migration v5 additive | DONE | test/review.test.ts |
| New dashboard (src/server/ui.html): Home (stats, live pipeline, setup checklist, upload, channel watch + pause), Clips (review inbox, edit dialog, Share via Web Share API, export), Publish, Insights, Studio, Setup (Autopilot, AI presets, social login). APIs: /api/setup, /api/activity, /api/autopilot, /api/sources/:id/status, /api/clips/:id/{review,meta,thumbnail,rerender,export} | DONE; real headless Chromium (390px + 1280px) screenshots checked, no JS/HTTP errors. Share button on a real phone NOT tested | test/dashboard.test.ts |
| Autopilot: UI toggles only `autoQueue`, `requireReview`, `platforms`; gates and `autoApprove` stay owner-only via CLI `autopilot on/off` (refuses risky flags without `--yes`); every UI change logged in state_log | DONE | test/dashboard.test.ts, manual CLI run |
Known: render is slow on 2 vCPU (2 clips of the 90s fixture ~9.5 min incl. zoompan+glow+particles+leak); turn off `edit.vfx.*`/`glow` for speed.

### REAL vs FAKE-TESTED vs NOT BUILT (read this first)
| Level | Items |
|---|---|
| **Verified for real** (real ffmpeg / real process / real browser) | ingest, analysis, clip selection, all editing effects (LUT, grain, particles, light leak, flash, jump cuts, slow-mo, zoom, progress bar, captions), QC, manifests + measured visual change, review/export/re-render, UI in headless Chromium, SQLite migrations, zip export |
| **Fake-server tested only** (code written from official docs, never run on the real service) | Telegram/Discord/Mastodon posting + owner notifications, live-chat/heatmap download, hardware encoders (probe only), YouTube upload/verify/schedule/comments, YouTube/Instagram/Facebook/TikTok analytics, Meta/TikTok/Google OAuth, Groq speech-to-text, any LLM provider (Groq/Gemini/OpenRouter/Mistral/Ollama), yt-dlp, faster-whisper |
| **Unverified here** | Docker build, systemd/install script, PaaS deploy, Termux render speed, Web Share on a real phone, TikTok/Meta https redirect requirements |
| **Heuristic, not intelligence** | clip scoring, hook/title/keyphrase engine, safety screen (keywords only), emotion labels from text cues, "40%" = measured structural change + effect coverage (not a copyright claim) |
| **NOT built** | password-login bots (refused on purpose), Instagram/TikTok/Facebook upload adapters (need app review + credentials; use Share/Export), caption translation, dubbing/TTS/voice cloning, speed-up of boring parts, sports/ball tracking, YouTube Analytics API (retention/CTR), id/password social login (deliberately: against platform terms) |

### Not done / blocked (do NOT claim these)
- Instagram/TikTok/Facebook upload adapters: **BLOCKED** (need owner creds/app review). YouTube adapter exists but is untested against real Google (needs owner OAuth client). Unverified-API-project visibility limits may apply on Google's side.
- IG/FB/TikTok OAuth login + token refresh and their upload adapters: NOT implemented (analytics read with an owner-supplied token only). Real-platform analytics calls never run.
- Real faster-whisper model run and real yt-dlp download: NOT tested here (not installed / network allowlist). Adapters are covered by fake-binary tests only.
- Docker build, systemd unit, install-vps.sh, PaaS deploy: NOT verified (sandbox: `docker` CLI exists but no daemon; npm/pip registries unreachable so yt-dlp/faster-whisper cannot be installed here; `npx skills add` also failed for that reason).
- autocap.in's own templates: not copyable (proprietary, only names/tags visible). We provide original presets instead.
- caption translation, per-word recolor, sports tracking, multi-account: NOT implemented.
- One caption font per clip: a clip mixing Hindi + Latin uses the dominant Indic font for all words (Noto/FreeSans include Latin glyphs, so it renders, but Latin words won't use Poppins).
- Scoring is heuristic, not a learned model.

## Known limitations (honest)
- Word timing in captions is APPROXIMATED from cue duration (no forced alignment).
- Render speed on 2 vCPU: ~225s for a 48s clip (veryfast, glow+zoompan). Tune `edit.preset`, disable `glow`/`zoom` for speed.
- Face tracking uses OpenCV Haar (basic); falls back to centered crop and says so in the manifest.
- Scoring is heuristic (audio/scene/speech/keyword); not a learned model. Emotion labels come from text cues only, never guessed from pixels.

## Verification log
- Session 5: 122/122 tests, typecheck clean; Schedule + Publish tabs checked in headless Chromium (390px + 1280px, no JS errors).
- Session 4: 108/108 tests, typecheck clean; live CLI render of 2 clips (coverage 0.81/0.95, visual change 0.17/0.23); dashboard screenshots checked in headless Chromium.
- Session 3: 86/86 tests (+ owner's Termux run: 80/80 before this block), typecheck clean.
- Session 1: 30/30 tests. Session 2: `npm test` 54/54 pass; typecheck 0 errors (global tsc + sandbox @types/node via typeRoots, since `npm install` is blocked in the sandbox).
- Real process verified: `npm start` boots from env, /healthz, SIGTERM exit 0, refuses public bind without token.
- Live full-flow run (real `npm start` process, default 1080x1920, fake STT engine): upload -> transcript (4 cues) -> 2 clips, QC pass, manifest `wordTiming: measured`, SRT/VTT exported, frames inspected (build-coral preset; Latin + Devanagari rendered). Found+fixed a real bug there: multi-line JSON from an STT engine was rejected.
- No upload/comment code path was ever exercised against a real platform.

## NEXT STEP (priority order)
00. Owner FIRST: `npm run cli -- smoke --url <any video> --upload short.mp4` (real Groq / yt-dlp / YouTube check; the tool never ran against the real services). Then connect each channel in Schedule tab, set per-channel policy.
0. Owner (autopilot): `npm run cli -- autopilot on --review --publish --yes` (clips wait for your Approve, upload unlisted only). Later `--approve --public --yes` for hands-off public posting. `autopilot off` closes everything.
1. Owner: deploy (DEPLOY.md), set `YT_CLIPS_TOKEN`, add a free Groq key (Setup tab) or run Ollama, upload a video you have rights to, open Clips tab and review.
2. First real run of yt-dlp + faster-whisper/Groq on the target server; fix whatever breaks.
3. Owner: Google OAuth client (device flow), connect, test ONE unlisted upload; fix whatever real Google disagrees with.
4. Unbuilt (see table above): Instagram/TikTok/Facebook upload adapters (after owner app review), caption translation, speed-up of boring parts, YouTube Analytics API pull, dubbing/TTS, Docker/VPS verification on a real host.
