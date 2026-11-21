# Pending checklist (from the owner files: Features yt-clips, Prompt, Yt-copyright, improvement)

## 2026-11-21 local completion pass
- [x] YouTube upload jobs bind the exact destination and use destination-specific idempotency.
- [x] Unlimited qualified candidate generation (0 = no clip-count ceiling); quality/overlap gates remain.
- [x] Per-destination mapping metadata: title prefix/suffix and extra tags; delay/priority/enable remain independent.
- [x] Horizontal→vertical platform derivation uses a fit_blur 1080x1920 derived copy; master stays untouched.
- [x] Live chat replay/heatmap sidecar parsing was already implemented and is retained; live chat capture against a real stream remains owner/device verified.
- [x] Channel content profiles now tune clip selection (including strict only-gaming and transcript-only auto inference); the legacy account profile and editing behavior are unchanged.

`[x]` done and covered by a test, `[ ]` pending, `[-]` deliberately NOT built (reason given).

## Feature ledger
- Use `docs/FEATURE_STATUS.md` for current evidence-based classifications; the historical “49 of 50” count is not a current completion claim.
- [x] 31 B-roll: built (Pexels, opt-in; live download UNVERIFIED)

## Real-world verification - UNVERIFIED / owner-side
- [ ] Asli YouTube upload after reconnect (OAuth app must be in Production, tokens die in 7 days in Testing)
- [ ] Termux: face tracking/OpenCV availability, local STT accuracy, render speed, and capture behavior
- [ ] Deploy on Render / Railway / Replit / Fly with the new files (owner must paste the first error line if it fails)
- [ ] Bluesky adapter against the real service (fake-server tested)
- [ ] Hindi STT accuracy with Groq whisper-large-v3 on his audio

## From `improvement`
- [x] Hardware encoder selection/fallback and parallel render lanes are implemented and locally tested; real GPU/device speed is UNVERIFIED.
- [x] Chat-replay/heatmap sidecar parsing and highlight signals are implemented; live-stream sidecar availability is UNVERIFIED.
- [x] Analytics import/learning logic is implemented and stub-tested; real provider analytics are UNVERIFIED.
- [x] Title rotation/A-B tracking is implemented; real CTR-based conclusions remain UNVERIFIED.
- [x] Gameplay + facecam layout, killfeed, Telegram notifications, multi-channel, YouTube sources; Kick/Twitch URL support is VOD-only (not live monitoring or upload).
- [x] Credential vault encrypts stored values with a locally generated key. `YT_CLIPS_SECRET_KEY` can provide an externally managed key; Windows ACL behavior is UNVERIFIED.
- [ ] LICENSE: the OWNER must choose the licence (nothing chosen for him)

## From `Yt-copyright` / `Prompt`
- [x] Unlisted-first upload, public gate, claim/ownership checks, "Claim aaya" button
- [-] Fingerprint-breaking filters (mirror/flip, pitch shift, micro-silences, colour shifts to beat Content ID): NOT built. They exist to evade copyright detection of other people's content; the tool only adds real transformation (captions, zoom, commentary) and uses unlisted-first checks.
- [-] "Auto-delete on claim + blacklist source": claims are surfaced to the owner (Claim aaya) instead of silent deletion.

## This round (owner clip_059 + friend message)
- [x] Short source (<= 75 s) -> exactly ONE clip (whole video, captions+effects, no cutting)
- [x] On-screen title cleaned of foreign letters; AI metadata (Groq gpt-oss) empty-answer fix
- [x] Tab bar: second "Studio" button no longer breaks navigation (blank #undefined page); select boxes no longer collapse to blank
- [x] Insights/Schedule/etc. no longer fail silently: red banner + Retry (+ "Reconnect" hint)
- [-] Publish queue auto-fill: clips go to the queue automatically when `automation.requireReview` is off; with review on (default) they wait for the owner's Approve on purpose
- [x] Speed option: exactly one of 1.05 1.06 1.07 1.08 1.09 1.10 (or 1 = off), default 1.05; ranges/other values rejected by API (400); applied after captions so words stay in sync
- [x] On-screen title: black/white strip glued to the top edge, whole clip start->end, contrasting text, up to 2 lines sized to the title; CTA moves under it
- [x] SEO package per clip: 50 keywords, tags fitted to YouTube's 500 chars, 50 hashtags (15 real #tags in the description, rest as plain words), 10 highlights, real YouTube search phrases (autocomplete); junk words (bhai/gaya/bees...) filtered everywhere
- [x] Description about/highlights forced to Roman Hinglish (English answer -> one rewrite request -> else template Hinglish)
- [ ] UNVERIFIED on device: real autocomplete results, Hinglish quality of the AI rewrite, title strip look on the phone's real video
- [ ] TubeBuddy/vidIQ: not integrated (paid, login-only, no public API); YouTube search autocomplete + the clip's own keywords are used instead
- [x] Title is printed AFTER the AI has watched the finished clip (frames + speech): clip renders without title, metadata step writes the title, `finishClip` prints it as the strip in one light pass (audio copied, QC re-run); hook fallback if the AI did not answer
- [x] Vision for Groq keys: Groq's text model (gpt-oss) cannot see images -> the same key's vision model is auto-detected (GROQ_VISION_MODEL overrides); the "no AI could describe" warning now says WHY
- [x] SEO relevance: AI tags/hashtags replace mis-heard transcript words; autocomplete only for 2-3 word topics (no more 'pani puri' for 'pani')
- [x] B-roll (Pexels stock cutaways, 1.6 s x up to 3 in the upper panel, off by default: `edit.broll:true` + PEXELS_API_KEY); without a key the clip's own close-up inserts are used
- [x] Start-up auto-install now also covers faster-whisper (PC/VPS/cloud; Termux uses whisper.cpp)
- [ ] UNVERIFIED on phone/cloud: Groq vision model call, Pexels download, finish pass timing on Termux

## Round 2026-11-14 (Fair Share + Live capture)
- [x] Fair Share round-robin (router.ts, tests, UI toggle) - unit/integration VERIFIED in sandbox, real multi-account upload UNVERIFIED
- [x] Live capture module (live-monitor.ts, tests with fakes) - logic VERIFIED, real live stream UNVERIFIED (needs owner's phone + a live channel)
- [ ] Hindi STT accuracy on phone - UNVERIFIED (needs phone)
- [x] Hardware encoding / parallel render selection and fallback are implemented and locally tested; phone/GPU performance remains UNVERIFIED.
- [x] Analytics-driven learning and title rotation are implemented/stub-tested; real analytics data and CTR conclusions remain UNVERIFIED.
- [x] Token encryption uses the encrypted vault and generated local key; external key management and Windows ACL behavior remain UNVERIFIED.
- [ ] Bluesky live test, Pexels B-roll live download, face tracking on phone (no opencv on Termux) - UNVERIFIED
- [ ] OWNER: YouTube OAuth Production + reconnect, real deploy error text, LICENSE, OpenRouter auto-fix key
- [ ] Source-burned text overlapping our captions - use caption position setting

## Round 2026-11-14 b
- [x] Per-source settings + backlog + permanent-error skip (VERIFIED with fake yt-dlp; real YouTube UNVERIFIED)
- [x] Auto-Avoid Burned Subs (synthetic-verified, real footage UNVERIFIED)
- [ ] OWNER: put cleared music in assets/music to activate BGM ducking; Task 3 termux-test script not requested this round

## Round 2026-11-14 c
- [x] Sequential lock + BUSY/IDLE UI (fake-yt-dlp verified; phone UNVERIFIED)
- [x] facecam_top layout (synthetic verified; real footage UNVERIFIED)
- [ ] OWNER decision: enable storage.freeAfterRender (loses re-render of that video)
- [x] Facecam auto-detect and face-only fallback are implemented and synthetic-tested; Termux and real-footage behavior remain UNVERIFIED.

## Round 2026-11-14 d
- [x] Auto facecam (synthetic-verified; real footage UNVERIFIED - watch log 'facecam auto-detect' scores)
- [x] autoCleanup + auto re-fetch + Re-fetch Source button (fake yt-dlp verified; phone UNVERIFIED)
- [x] Parallel jobs setting (env + dashboard)

- [ ] (2026-11-15) Real OAuth: set OAUTH_PUBLIC_BASE_URL to https tunnel, register redirect URI in Meta/TikTok, connect once.
- [ ] (2026-11-15) Phone: test a face-only talking video (no OpenCV) -> expect Fill crop centred on face; set edit.faceFallback=false if it misfires.

- [ ] (2026-11-15) Run `npm run cli -- automation on --approve` + set gates on server for true hands-free; then check Clips tab shows only "Status:".
- [ ] (2026-11-15) Check Part 1/2/3 cut points on a real story video (splitter heuristics are Hinglish-word based, UNVERIFIED on real transcripts).

- [ ] (2026-11-15) Phone: `pkg install cloudflared`; `YT_CLIPS_TUNNEL=1 npm start`; copy the https redirect URI shown in Settings into Meta/TikTok.
- [ ] (2026-11-15) Re-render clip_064-type (PC game + small facecam) and check cam crop/zone; if a HUD corner (minimap) is mistaken for a cam set edit.autoFacecam=false for that channel.

- [ ] (2026-11-15) Enable GitHub Pages (repo Settings → Pages → Branch main, folder /docs); open https://abhikun208.github.io/Yt-clips/oauth-relay.html (should say "state galat"); then Relay ON in Settings and register that single URI in Meta.

- [ ] (2026-11-16) Meta: after the next successful login pick a Page per channel in Settings; TikTok multi-account NOT built.
- [ ] (2026-11-16) YouTube: reconnect each channel after the Client ID/Secret is final (unauthorized_client = client changed). Google Cloud → consent screen → Publish app so tokens do not die in 7 days.
- [ ] (2026-11-17) Google Cloud → OAuth consent screen → Test users: add EVERY Google account you connect (or Publish app).
- [ ] (2026-11-17) Phone: `git pull && npm start` → Setup → Connected Accounts. Connect 2 Google accounts; both must list. Disconnect one → other stays Connected.
- [ ] (2026-11-17) Meta: login with 2nd Facebook user → both users' Pages should appear; TikTok: 2nd login should add a 2nd row. TikTok/Meta real publishing still OFF until you authorize.

## 2026-11-19 additions
- [ ] Owner: Phone par `git pull && npm start`; Setup → Connected Accounts → **Test** dabao har account par (Main abhi expired hona chahiye) → Main Reconnect.
- [ ] Owner: Decider ke sources ko Decider channel par assign karo (ya source→destination mapping API) — default Main hai.
- [x] Per-account schedule limits, source mapping UI, dashboard tabs, and Meta/TikTok Test Connection are implemented/fake-tested; full dynamic-action browser coverage remains partial.
- [ ] Dev: parent batch/PARTIAL_SUCCESS behavior and full per-destination schedule/metadata profiles.
- [x] Test Connection Facebook/Instagram/TikTok (fake-server verified; real tokens UNVERIFIED)

- [x] Auto-Pilot lanes / queue heartbeat + restart recovery / live probe+rolling capture / Live Priority Mode / unlimited duration + sectioned download / missing-file re-render (fake-verified; real streams UNVERIFIED)
- [ ] Owner: run on phone `git pull && npm start`, enable "Live" on @ishowspeed source, check /api/live and Queue

- [x] Rolling live buffer retention + caps + boot cleanup (local-verified)
- [x] Live card/Priority UI, mapping enable/delay UI, bulk distribute UI (Chromium click-through)
- [x] Platform re-encode with FFprobe re-validation
- [x] docs/FEATURE_STATUS.md classification
- [ ] OWNER: run `npm run verify:device -- --capture` on Termux while @ishowspeed is live; share data/device_verification.json
- [x] Live chat/heatmap sidecar parsing, per-destination title prefix/suffix/tags, and horizontal→vertical derived copies exist; real sidecar capture and platform-specific policy UI are PARTIAL/UNVERIFIED.
- [ ] AI upscale / 16:9 2560×1440 output is NOT_IMPLEMENTED.

## Final local audit (2026-11-21)
- [x] PC/VPS PyAV 18 + faster-whisper compatibility checked in isolated Python; synthetic audio decoder smoke test passed.
- [x] STT provider-network cooldown now continues to local STT on subsequent clips; mocked-provider/local-VoiceStudio regression passed.
- [x] `npm run typecheck` passed; focused STT tests passed 2/2; orchestration/security tests passed 21/21; isolated stale-output render recovery passed 1/1.
- [ ] Full `test/logfix.test.ts` suite: its broad run was interrupted at the local-model timeout; only the focused render-recovery test is verified.
- [x] Local dashboard is running at `http://127.0.0.1:8080` with background automation disabled; Chromium shows the 8 tabs and empty Clips inbox.
- [x] Project DB read-only check: sources/jobs/videos/clips/uploads/studio generations all contain 0 rows; no live-edit preview exists yet. Default data/output path is this project’s `data/` directory.
- [ ] Real Termux, live stream, OAuth/account, deployment, provider analytics, and real speech-quality checks remain owner/device-only; no public upload or approval gates were enabled.
- [ ] Kick live monitoring/capture remains unimplemented; Kick's documented Public API currently requires an app/user access token for livestream queries. No app credentials or account authorization were provided.
- [-] Automated Kick video upload is not built: the current official API docs do not document a video-upload endpoint. Revisit only if Kick publishes a supported endpoint and the owner explicitly approves account authorization.

## Continued prompt audit (2026-11-21)
- [x] Content profile API, channel UI, manual strategy scoring, strict only-gaming filtering, conservative transcript-only auto inference, and custom vocabulary are implemented and covered by focused tests.
- [x] Short-source whole-video fallback now respects only-gaming rejection; verified with a synthetic media + unrelated transcript regression.
- [x] Existing `src/edit/*` implementation, presets, fonts, effects, transitions, and rendering behavior were not changed.
- [x] Kick VOD URL parsing is tested; Kick channel/live monitoring and account uploads are not claimed as supported.
- [ ] Restart the existing localhost dashboard with `npm start` to load the updated profile controls; the current listener still serves pre-change HTML. No active source/job/clip exists for a live editing preview.
- [ ] Full `test/adapters.test.ts` is not green on this Windows run: 3 fake-yt-dlp/STT adapter tests fail (`0 !== 2`, `spawn EFTYPE`, and missing offline result); the focused URL-validation test passes. Investigate separately before claiming the adapter suite is verified.
