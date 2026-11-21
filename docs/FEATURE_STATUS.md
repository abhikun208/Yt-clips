# Feature status (Prompt1 P6) — honest classification

Legend: **VERIFIED-LOCAL** = automated test with real ffmpeg/ffprobe/Chromium on a real local DB · **MOCK-TESTED** = tested only against fake Google/Meta/TikTok/yt-dlp servers or scripts (NOT provider verification) · **UNVERIFIED** = code exists, never run against the real service/device · **BLOCKED_EXTERNAL** = needs something only the owner can provide · **NOT_IMPLEMENTED**.
Nothing here is "VERIFIED" against real YouTube / Meta / TikTok / Android Termux — no such run has been made from the sandbox. Run `npm run verify:device` (and `-- --capture`) on the phone to produce real evidence (`data/device_verification.json`).

| Area | Feature | Status | Test / note |
|---|---|---|---|
| Live | Live detection (probe, ladder, upcoming=offline) | MOCK-TESTED + UNVERIFIED | test/live_probe.test.ts (fake yt-dlp); real @ishowspeed untested |
| Live | Rolling capture (chunks, reconnect, resume after blip, stop when ended) | MOCK-TESTED + UNVERIFIED | test/live.test.ts (fake recorder); ffmpeg `-reconnect` flags real only on device |
| Live | Rolling buffer retention (raw chunk deleted after highlights rendered, size cap, age cap, boot cleanup) | VERIFIED-LOCAL | test/live_retention.test.ts. Granularity = one 5-min chunk, not sub-chunk |
| Live | Clips while live (analyze→render→QC→metadata→queue per chunk) | VERIFIED-LOCAL (pipeline) / UNVERIFIED (real stream) | chunk latency = chunk length (default 300 s) |
| Live | Moment detection signals: speech (STT), audio energy, scene change, kill-feed/gameplay, face mood | VERIFIED-LOCAL on files | live **chat/engagement** signals are NOT captured from live streams (NOT_IMPLEMENTED) |
| Live | Live Priority Mode (claim order + fair-share bypass; per-source UI; API) | VERIFIED-LOCAL | test/live_priority.test.ts, test/ui_live.test.ts |
| Live | Live monitoring card (status, last chunk, failures, buffer MB) | VERIFIED-LOCAL (Chromium) | |
| Runtime | 3-lane loop, queue heartbeat, restart recovery | VERIFIED-LOCAL | test/lanes, queue_recovery |
| Runtime | Termux behaviour (Auto-Pilot, Queue, Live) | UNVERIFIED | `verify-device` produces the evidence |
| Long video | No duration limit; 60-min section download | MOCK-TESTED + UNVERIFIED | test/longvideo.test.ts (window math); real yt-dlp `--download-sections` untested |
| Routing | Multi-account/source→many, per-destination enable + delay, bulk distribute UI | VERIFIED-LOCAL (fake provider) | test/source_mapping, ui_bulk, distribute |
| Routing | Per-destination title/tag policy (prefix/suffix/extra tags/drop tags) | API_ONLY + MOCK-TESTED (unit/DB; wiring in `advance` not yet e2e-tested; no UI control yet) | `POST /api/sources/:id/destinations` `policy`; stored clip metadata untouched |
| Scheduling | Per-account timezone / daily limits / missed-job reschedule | MOCK-TESTED | account_timezone, missed_job |
| Media | Platform re-encode (size/duration/codec) + FFprobe re-validation, master untouched | VERIFIED-LOCAL | test/derive.test.ts. Horizontal→vertical conversion NOT done (blocked with clear error) |
| Media | Missing output file → re-render + resume | VERIFIED-LOCAL | test/missing_file.test.ts |
| YouTube | Upload (resumable), identity guard, reconnect, token health | MOCK-TESTED | fakeGoogle; real upload needs owner login; **Main account needs reconnect** |
| Meta (FB/IG) | Login/upload/Test Connection | MOCK-TESTED (Test Connection) / BLOCKED_EXTERNAL (login) | needs public HTTPS callback domain |
| TikTok | Login/upload/Test Connection | MOCK-TESTED (Test Connection) / BLOCKED_EXTERNAL (Direct Post audit) | manual-post fallback is marked manual, never "uploaded" |
| Safety | publish / public visibility / auto-comments gates OFF + read-only in UI | VERIFIED-LOCAL | |
| UI | 8 tabs, controls → real APIs | VERIFIED-LOCAL (Chromium: tabs, live, bulk) | other dynamic buttons covered by API-route tests only |
| AI | Local Ollama slot | BLOCKED_EXTERNAL | not running on owner device |
| AI | Upscaling / 16:9 2560×1440 | NOT_IMPLEMENTED (secondary) | |
