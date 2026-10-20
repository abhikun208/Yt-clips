# PROGRESS.md — persistent ledger (kisi bhi AI/session ko yahin se resume karna hai)

> Rule: sirf wahi "DONE" jo code + test/verify ho chuka hai. Baaki sab PARTIAL / TODO / BLOCKED.
> Last updated: 2026-10-20 (session 1)

## Resume kaise karein
1. `Prompt` file = original owner requirements (Hinglish). `BRAIN.md` = architecture + decisions.
2. `npm run typecheck && npm test` chalao, phir neeche "NEXT STEP" se aage badho.
3. Runtime dependencies ZERO (Node >=22.18, `node:sqlite`, `node:test`). Dev: typescript, @types/node (is sandbox mein npm registry blocked tha, typecheck global `tsc` se hota hai).

## Environment facts (verified)
- Node v22.22, ffmpeg/ffprobe 6.1.1 (libx264, aac, subtitles/libass, loudnorm, zoompan, scdet, silencedetect), python3 + opencv (face helper optional).
- NOT available here: yt-dlp, whisper/whisper.cpp, npm registry (403). Isliye: YouTube download aur speech-to-text optional adapters hain; sidecar `.srt/.vtt/.json` transcript supported.

## Status
| Area | Status | Evidence |
|---|---|---|
| Config + safety gates (publish/comments/public all OFF) | DONE | src/config.ts |
| SQLite store, non-destructive migrations, persistent job queue (lease/backoff/jitter/DEAD) | DONE (smoke-tested) | src/db.ts |
| Local source ingest + fingerprint dedup (original copied, never modified) | DONE (real run) | src/sources/local.ts |
| Full-timeline analysis (silence, scenes, audio energy, black, intro/outro detect) | DONE (real run on synthetic fixture: intro 6.03s, outro 83.82s detected) | src/analysis/* |
| Candidate ranking + overlap NMS + snap to pauses + cross-run dedup fingerprint | DONE (real run) | src/analysis/select.ts |
| Editing engine: raw clip + edited short in separate folder, manifest, ffprobe QC | DONE (real render: 1080x1920 h264/aac, -14.1 LUFS, QC pass) | src/edit/* |
| Treatment coverage = 13/16 dimensions (measured in manifest, not a legality claim) | DONE | manifest.treatmentCoverage |
| speed_ramp, beat_effects, music ducking (needs owner-supplied music) | TODO / not implemented | — |
| SEO metadata/thumbnail, scheduler, publish state machine, comments, CLI, tests, platform adapters | IN PROGRESS (this session) | see NEXT STEP |
| YouTube/Instagram/TikTok real API upload | BLOCKED until owner OAuth creds + explicit authorization | gates OFF |

## Known limitations (honest)
- Word timing in captions is APPROXIMATED from cue duration (no forced alignment).
- Render speed on 2 vCPU: ~225s for a 48s clip (veryfast, glow+zoompan). Tune `edit.preset`, disable `glow`/`zoom` for speed.
- Face tracking uses OpenCV Haar (basic); falls back to centered crop and says so in the manifest.
- Scoring is heuristic (audio/scene/speech/keyword); not a learned model. Emotion labels come from text cues only, never guessed from pixels.

## NEXT STEP
Build seo/, schedule/, publish/ state machine, comments/, cli.ts, tests, BRAIN.md; then commit + push.
