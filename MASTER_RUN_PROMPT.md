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

## Product flow (owner's requirements, mapped)
1 Sources: local files (done), YouTube channel/new-upload polling + manual adds (TODO: needs yt-dlp/API).
2 Analyze the whole video start→end, skip real intro/outro (done).
3–4 Timecoded, ranked, de-duplicated clips with reasons (done). Emotional/funny/cute/etc. labels come from transcript cues only.
5 Editing into a NEW folder: 9:16 reframe, grade, zoom, glow, vignette, captions+title, audio clean + -14 LUFS, manifest, QC (done). Speed ramp & beat effects (TODO).
6–8 Reference research → `docs/FEATURE_MATRIX.md` (done; findings are honest, incl. what could not be reused).
9 Hinglish title/description/tags/thumbnail (template-based done; LLM adapter TODO), comment replies in draft/approval mode (done).
10 Scheduler from evidence, unlisted-verify-then-publish state machine (logic done; real platform adapters BLOCKED on owner OAuth).
11 Manual sources anytime (`cli add`). 12–13 Automatic run via the persistent job queue (`cli run`); channel watching TODO.
14 Owner delegated management to the AI: keep PROGRESS.md truthful; prefer small reversible changes.

## Commands
`npm test` · `npm run typecheck` · `npm run doctor` · `npm run cli -- add <file> --authorized` · `run` · `status` · `plan 5`

## Definition of done per phase
Code + test passing + PROGRESS.md updated with real results + next step. Report verified facts separately from assumptions.
