# PROGRESS.md — persistent ledger (kisi bhi AI/session ko yahin se resume karna hai)

> Rule: sirf wahi "DONE" jo code + test/verify ho chuka hai. Baaki sab PARTIAL / TODO / BLOCKED.
> Last updated: 2026-10-23 (session 3). Audit: fresh `git clone` of main -> `npm test` 80/80.

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
- Session 3: 86/86 tests (+ owner's Termux run: 80/80 before this block), typecheck clean.
- Session 1: 30/30 tests. Session 2: `npm test` 54/54 pass; typecheck 0 errors (global tsc + sandbox @types/node via typeRoots, since `npm install` is blocked in the sandbox).
- Real process verified: `npm start` boots from env, /healthz, SIGTERM exit 0, refuses public bind without token.
- Live full-flow run (real `npm start` process, default 1080x1920, fake STT engine): upload -> transcript (4 cues) -> 2 clips, QC pass, manifest `wordTiming: measured`, SRT/VTT exported, frames inspected (build-coral preset; Latin + Devanagari rendered). Found+fixed a real bug there: multi-line JSON from an STT engine was rejected.
- No upload/comment code path was ever exercised against a real platform.

## NEXT STEP (priority order)
0. To run the autonomous loop the owner edits `data/config.json`: `{"automation":{"autoQueue":true,"autoApprove":false},"gates":{"publishEnabled":true}}`; add `autoApprove:true` and `publicVisibilityAllowed:true` only when ready for public posting.
1. Owner: deploy (DEPLOY.md), set `YT_CLIPS_TOKEN`, upload a video you have rights to, check `data/edited_shorts` + manifests + caption preset choice.
2. First real run of yt-dlp + faster-whisper on the target server; fix whatever breaks (see "NOT tested" above).
3. Owner: create a Google Cloud OAuth client (type "TVs and Limited Input devices" for `youtube-connect`; type "Desktop app" for `youtube-connect-full`), set `YT_OAUTH_CLIENT_ID/SECRET`, run `npm run cli youtube-connect`, then test ONE private/unlisted upload with gates still limited (edit `data/config.json` yourself: `publishEnabled` only). Fix whatever real Google disagrees with.
4. Unbuilt: speed-up of boring parts, caption translation, Instagram/TikTok/Facebook UPLOAD adapters (need owner app review), YouTube Analytics API (retention/CTR) auto-pull, Docker/VPS verification on a real host.
