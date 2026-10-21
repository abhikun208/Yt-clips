# PROGRESS.md — persistent ledger (kisi bhi AI/session ko yahin se resume karna hai)

> Rule: sirf wahi "DONE" jo code + test/verify ho chuka hai. Baaki sab PARTIAL / TODO / BLOCKED.
> Last updated: 2026-10-21 (session 1)

## Resume kaise karein
1. `Prompt` file = original owner requirements (Hinglish). `BRAIN.md` = architecture + decisions.
2. `npm run typecheck && npm test` chalao, phir neeche "NEXT STEP" se aage badho.
3. Runtime dependencies ZERO (Node >=22.18, `node:sqlite`, `node:test`). Dev: typescript, @types/node (is sandbox mein npm registry blocked tha, typecheck global `tsc` se hota hai).

## Environment facts (verified)
- Node v22.22, ffmpeg/ffprobe 6.1.1 (libx264, aac, subtitles/libass, loudnorm, zoompan, scdet, silencedetect), python3 + opencv (face helper optional).
- NOT available here: yt-dlp, whisper/whisper.cpp, npm registry (403). Isliye: YouTube download aur speech-to-text optional adapters hain; sidecar `.srt/.vtt/.json` transcript supported.

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
| Comments: classify, PII/spam never answered, drafts only, posting needs opt-in + approval | DONE (no posting adapter) | test/publish.test.ts |
| Job worker (analyze->render->meta), restart is a no-op, never uploads by itself | DONE | e2e test 2 |
| CLI + doctor | DONE | `npm run doctor` |
| Reference research + honest matrix | DONE | docs/FEATURE_MATRIX.md |

### Not done / blocked (do NOT claim these)
- Real YouTube/Instagram/TikTok/Facebook adapters: **BLOCKED** (needs owner OAuth app credentials + explicit authorization). Only DryRunAdapter exists.
- Platform analytics ingestion for the scheduler: NOT implemented (scheduler uses baseline until stats are supplied).
- Speech-to-text: NOT implemented (whisper/faster-whisper absent here). Captions work from sidecar `.srt/.vtt/.json`.
- YouTube channel watching / yt-dlp download: NOT implemented (yt-dlp absent; outbound network is allowlisted).
- speed_ramp, beat_effects, caption translation, sports tracking, LLM metadata: NOT implemented.
- Thumbnail text with Devanagari relies on system font fallback; unverified on a real Hindi title.

## Known limitations (honest)
- Word timing in captions is APPROXIMATED from cue duration (no forced alignment).
- Render speed on 2 vCPU: ~225s for a 48s clip (veryfast, glow+zoompan). Tune `edit.preset`, disable `glow`/`zoom` for speed.
- Face tracking uses OpenCV Haar (basic); falls back to centered crop and says so in the manifest.
- Scoring is heuristic (audio/scene/speech/keyword); not a learned model. Emotion labels come from text cues only, never guessed from pixels.

## Verification log (session 1)
- `npm test`: 30/30 pass (unit + real ffmpeg end-to-end). Typecheck: 0 errors (global tsc + sandbox @types/node via typeRoots; repo's own `npm install` was blocked by the sandbox proxy, so run `npm install` once on your machine).
- `npm run doctor`: ffmpeg/ffprobe/node OK; yt-dlp & whisper WARN (optional).
- Safety: no upload or comment code path was exercised against a real platform.

## NEXT STEP (in priority order)
1. Owner: run `npm install` locally, `npm test`, then `npm run cli -- add <video> --authorized` and `run`; review `data/edited_shorts` + manifests.
2. STT adapter: call `whisper-cli`/`faster-whisper` when installed -> write `<video>.json` sidecar (src/analysis/transcript.ts already reads it); then test with a real speech sample.
3. Source adapter: yt-dlp wrapper (+ channel polling) behind `sources/`, only for authorized channels.
4. Real YouTube adapter (Data API resumable upload, unlisted->verify) in `src/publish/`; needs owner OAuth creds; keep gates OFF until owner approves.
5. speed_ramp + beat effects, then LLM metadata adapter (optional, key via .env).
