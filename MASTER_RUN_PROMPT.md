# MASTER_RUN_PROMPT.md — primary project spec (consolidated from `Prompt`, de-duplicated, reality-checked)

Role: principal engineer on the EXISTING repo. Read this, then `PROGRESS.md` (ledger + NEXT STEP), then `BRAIN.md`. Never restart from scratch; always resume from PROGRESS.md.

## Non-negotiables
1. Preserve all existing files/data. No DB reset/drop/truncate; migrations are additive only. No destructive git commands.
2. `gates.publishEnabled`, `gates.commentsAutoPost`, `gates.publicVisibilityAllowed` stay **false** until the owner explicitly enables them in `data/config.json`. Tests never publish.
3. Never print/commit secrets. Tokens are redacted from logs.
4. Never mark a feature DONE unless implemented AND verified (test or real run). Otherwise PARTIAL / NOT IMPLEMENTED / BLOCKED with the exact blocker.
5. Originals (`data/source_videos`, `raw_clips`) are immutable; new edits go to `data/edited_shorts` with a manifest; outputs are never overwritten.
6. Free/open-source first. Do not bypass paid APIs, quotas, subscriptions or platform rules. "Premium features free" = re-implement with FFmpeg/OpenCV/local models, or document the limit.
7. Only authorized sources. Owner confirms rights (`--authorized`); the "40% visual change" is an editing-quality target, never a copyright workaround. No guarantee of views.
8. Links/handles in metadata only if owner-configured. Never invent facts or URLs.

## Product flow (owner's requirements → current status; PROGRESS.md has the detailed ledger)
1 Sources: local files, YouTube channel watching (poll) + manual adds via yt-dlp; per-source → channel mapping (children follow the parent). Real yt-dlp/YouTube run: owner-side verification pending.
2 Analysis first: whole video, intro/outro skipped, transcript (local whisper.cpp / API / Gemini) → candidates snapped to sentence boundaries; long stories become "Part n/N" series (`clip.series`); `reanalyze <videoId> [--from --to --length --whole]` for old videos.
3 Ranked, timecoded, de-duplicated clips with reasons + viral score.
4 Editing (new folder, originals immutable): 9:16 reframe (crop + speaker-follow keyframes, fit_blur, gamer_stack, split_gameplay), grade, 288 caption presets, Hinglish captions per channel (`translateTo`/`edit.captionLanguage`), real-sentence hook title (never a template), PART label, CTA, audio chain, VFX, QC, manifest.
5 Metadata (analysis-first): brief → title options, structured description (about, highlights, time map, search, related, links, hashtags), tags, thumbnail (best of 5 frames), CTR/SEO checklist score. LLM only fills validated fields; local fallback always works. No invented facts/links; no view guarantees.
6 Account optimizer per channel (description, keywords, bio, playlists, pinned comment, checklist); YouTube apply is explicit + GET-then-merge.
7 Publish: gated state machine (unlisted first, owner gates), schedule from evidence, all platform adapters share title/description (platform caption limits respected).
8 Learn from analytics; comment replies in draft/approval mode.
9 Automatic run via the persistent job queue (`cli run` / server loop).
10 Owner delegated management to the AI: keep PROGRESS.md truthful; prefer small reversible changes.

## Working rules for the AI (owner's standing instructions)
- Reply to the owner in Hinglish; separate verified facts from stand-in-tested/unverified.
- No skills/AGENTS.md/CLAUDE.md inside this repo. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` + `Claude-Session: <session url>`; push with `git push -q origin HEAD:main`.
- Never remove an existing feature. New work → tests; run the full suite in 4 batches (`node --test test/[a-d]*.test.ts`, `[e-l]`, `[m-r]`, `[s-z]`) + `tsc`.
- The owner never shares passwords (OAuth only). Declined by design: copying third-party templates (autocap.in), automatic removal of third-party logos.

## Commands
`npm test` · `npm run typecheck` · `npm run doctor` · `npm run cli -- add <file> --authorized` · `run` · `status` · `plan 5`

## Definition of done per phase
Code + test passing + PROGRESS.md updated with real results + next step. Report verified facts separately from assumptions.


## Pending work
See `PROGRESS.md` → "PENDING WORK" (single source of truth, includes the triage of the pasted production-upgrade prompt). If a feature already exists, ignore it; otherwise build it.

## Development discipline (owner's rules — always)
1. Unit tests are a must for everything that is developed.
2. Integration tests always (real ffmpeg / real server / fake platform where needed).
3. TDD: write the test cases first, then the code.
4. When a feature is "complete": switch role to security agent / pen-tester and try to BREAK it. Report findings as points ONLY — do not fix in that step.
5. Discuss the findings with the owner, then fix them one by one (a test for each).
6. After that: simulate thousands of users (load / many sources / many channels) and report what breaks and which flows fail.
