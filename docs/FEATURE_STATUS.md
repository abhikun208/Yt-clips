# Feature status (Prompt1 P6) — honest classification

Legend: **VERIFIED-LOCAL** = automated test with real ffmpeg/ffprobe/Chromium on a real local DB · **MOCK-TESTED** = tested only against fake Google/Meta/TikTok/yt-dlp servers or scripts (NOT provider verification) · **UNVERIFIED** = code exists, never run against the real service/device · **BLOCKED_EXTERNAL** = needs something only the owner can provide · **NOT_IMPLEMENTED**.
Nothing here is "VERIFIED" against real YouTube / Meta / TikTok / Android Termux — no such run has been made from the sandbox. Run `npm run verify:device` (and `-- --capture`) on the phone to produce real evidence (`data/device_verification.json`).

| Area | Feature | Status | Test / note |
|---|---|---|---|
| Live | Live detection (probe, ladder, upcoming=offline) | MOCK-TESTED + UNVERIFIED | test/live_probe.test.ts (fake yt-dlp); real @ishowspeed untested |
| Live | Rolling capture (chunks, reconnect, resume after blip, stop when ended) | MOCK-TESTED + UNVERIFIED | test/live.test.ts (fake recorder); ffmpeg `-reconnect` flags real only on device |
| Live | Rolling buffer retention (raw chunk deleted after highlights rendered, size cap, age cap, boot cleanup) | VERIFIED-LOCAL | test/live_retention.test.ts. Granularity = one 5-min chunk, not sub-chunk |
| Live | Clips while live (analyze→render→QC→metadata→queue per chunk) | VERIFIED-LOCAL (pipeline) / UNVERIFIED (real stream) | chunk latency = chunk length (default 300 s) |
| Live | Moment detection signals: speech (STT), audio energy, scene change, kill-feed/gameplay, face mood, live-chat replay/heatmap sidecars | VERIFIED-LOCAL on files | live-chat capture itself is source/YT-DLP sidecar-dependent; real stream UNVERIFIED |
| Live | Live Priority Mode (claim order + fair-share bypass; per-source UI; API) | VERIFIED-LOCAL | test/live_priority.test.ts, test/ui_live.test.ts |
| Live | Live monitoring card (status, last chunk, failures, buffer MB) | VERIFIED-LOCAL (Chromium) | |
| Analysis | Channel content profiles (general/auto/gaming/only-gaming/vlog/mixed/podcast/comedy/reaction/educational/custom) | VERIFIED-LOCAL | test/analysis.test.ts, test/channels.test.ts, test/e2e.test.ts; `auto` infers gaming only from multiple transcript callouts |
| Analysis | only-gaming content gate, including short-source fallback | VERIFIED-LOCAL | test/analysis.test.ts and test/e2e.test.ts; unrelated short video is rejected |
| Runtime | 3-lane loop, queue heartbeat, restart recovery | VERIFIED-LOCAL | test/lanes, queue_recovery |
| Runtime | Termux behaviour (Auto-Pilot, Queue, Live) | UNVERIFIED | `verify-device` produces the evidence |
| Long video | No duration limit; 60-min section download | MOCK-TESTED + UNVERIFIED | test/longvideo.test.ts (window math); real yt-dlp `--download-sections` untested |
| Routing | Multi-account/source→many, per-destination enable + delay, bulk distribute UI | VERIFIED-LOCAL (fake provider) | test/source_mapping, ui_bulk, distribute |
| Routing | Per-destination title/tag policy | VERIFIED-LOCAL (mapping DB/API) | title prefix/suffix + extra tags are applied per mapped source/destination at upload |
| Routing | Per-destination platform-specific metadata policy (prefix/suffix/tags) + delay | MOCK-TESTED / VERIFIED-LOCAL (UI) | storage + pure apply + upload wiring tested; Sources UI edit verified with Chromium (test/ui_destmeta.test.ts); live provider behaviour UNVERIFIED |
| Scheduling | Per-account timezone / daily limits / missed-job reschedule | MOCK-TESTED | account_timezone, missed_job |
| Media | Platform re-encode (size/duration/codec) + FFprobe re-validation, master untouched | VERIFIED-LOCAL | test/derive.test.ts. Horizontal→vertical uses fit_blur-derived 1080x1920 copy |
| Media | Missing output file → re-render + resume | VERIFIED-LOCAL | test/missing_file.test.ts |
| AI | PC/VPS STT dependency/runtime compatibility | VERIFIED-LOCAL (decoder smoke) | Isolated Python with PyAV 18 + faster-whisper decoded a synthetic 16 kHz audio sample; real speech transcription quality is UNVERIFIED |
| AI | STT provider network cooldown and local fallback | MOCK-TESTED | test/hardening.test.ts uses mocked cloud failure and local VoiceStudio endpoint; no provider credentials or real audio sent |
| Analytics | Analytics import / learning / title rotation | MOCK-TESTED | local logic and stubs only; real account analytics and CTR evidence are UNVERIFIED |
| YouTube | Upload (resumable), identity guard, reconnect, token health | MOCK-TESTED | fakeGoogle; real upload needs owner login; **Main account needs reconnect** |
| Kick | VOD URL allowlist (single video only) | VERIFIED-LOCAL (URL parsing only) | test/adapters.test.ts; actual Kick downloads were not run |
| Kick | Live monitoring/capture and account video upload | NOT_IMPLEMENTED / BLOCKED_EXTERNAL | Current official docs describe authenticated livestream/channel APIs but no documented video-upload endpoint; no Kick app credentials or account authorization used. See https://docs.kick.com/apis/livestreams.md and https://docs.kick.com/apis/channels.md |
| Meta (FB/IG) | Login/upload/Test Connection | MOCK-TESTED (Test Connection) / BLOCKED_EXTERNAL (login) | needs public HTTPS callback domain |
| TikTok | Login/upload/Test Connection | MOCK-TESTED (Test Connection) / BLOCKED_EXTERNAL (Direct Post audit) | manual-post fallback is marked manual, never "uploaded" |
| Safety | publish / public visibility / auto-comments gates OFF + read-only in UI | VERIFIED-LOCAL | |
| UI | 8-tab dashboard and API wiring | VERIFIED-LOCAL / PARTIAL | Chromium confirms Prompt1 tab labels/order, live and bulk flows; full dynamic-action click-through remains incomplete |
| AI | Local Ollama slot | BLOCKED_EXTERNAL | not running on owner device |
| AI | Upscaling / 16:9 2560×1440 | NOT_IMPLEMENTED (secondary) | |
| Analysis | Content type/sub-type detection, quality gate, grounded metadata | MOCK-TESTED | test/shorts_engine.test.ts; transcript heuristics only, real-video accuracy UNVERIFIED; uncommitted |
| Framing | Smart Framing advisor (multi-person crop vs fit_blur, gaming-safe crop guard), default OFF, toggle in Studio | MOCK-TESTED (FAKE face data, real FFmpeg render) | test/framing*.test.ts + framing_render_hook + framing_config; real face/active-speaker detection and HUD zones on real games UNVERIFIED (sandbox OpenCV has no detector) |
| Framing | True multi-tile split/trio layouts, content-specific styles, context SFX/music/B-roll | BLOCKED_LOCKED | need new branches in locked src/edit/filters.ts; owner approval required |
