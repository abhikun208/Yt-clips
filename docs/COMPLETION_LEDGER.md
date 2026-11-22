# COMPLETION LEDGER (single source for this audit; sandbox = Linux container with real ffmpeg/ffprobe/Chromium, no Termux, no real YouTube/Meta/TikTok)

Scope source: MASTER_RUN_PROMPT.md. Locked: `src/edit/filters.ts` was NOT modified (`git diff --quiet src/edit/filters.ts` = clean). `src/edit/render.ts` contains only the owner-approved framing hook (default OFF).

## COMPLETE + VERIFIED (sandbox only)
| # | Item | Test command | Output |
|---|---|---|---|
| 1 | Content type/sub-type detection, quality gate (duplicate/repeated hook/missing context/bad boundary/weak payoff, 0 Shorts allowed), grounded titles | `node --test test/shorts_engine.test.ts test/framing.test.ts test/framing_advisor.test.ts test/framing_config.test.ts test/styles_recipes.test.ts test/ui_destmeta.test.ts` | `# tests 27 / # pass 27 / # fail 0 / # skipped 0` |
| 2 | Framing planner + advisor decision logic (single/split/trio, hysteresis, gaming-safe crop, every detector-failure mode -> undefined) with FAKE face data | same command as #1 | included in the 27 |
| 3 | Render hook: flag unset == flag false == flag on + detector unavailable (identical render); FAKE close faces -> crop; far faces -> fit; gaming no-face -> centred crop keeping HUD zones; unsafe protected region -> fit_blur (real FFmpeg renders) | `node --test test/framing_render_hook.test.ts` | `# pass 3 / # fail 0` |
| 4 | Smart Framing toggle: default OFF, POST /api/config boolean only, persisted, gates untouched, UI checkbox present | in command #1 (framing_config) | included in the 27 |
| 5 | Per-destination metadata policy editing in Sources (real Chromium click-through) | in command #1 (ui_destmeta) | included in the 27 |
| 6 | Style recipes + cue planner (pure logic; see IMPLEMENTED for effect on output) | in command #1 (styles_recipes) | included in the 27 |
| 7 | filters.ts proposal patch applies cleanly and does not touch the real file | `git apply --check docs/filters.proposal.patch && echo APPLY_CHECK_OK` | `APPLY_CHECK_OK` |
| 8 | Same patch on a THROWAWAY copy: 2 and 3 tiles render 1080x1920; the 5 existing reframe modes x 3 source sizes give identical `reframeParts` output before/after | one-off script on the scratch copy (not in repo) | `2 1080,1920 \| multi-person stack: 2 tiles (960+960px)` / `3 1080,1920 \| ... 3 tiles (640+640+640px)` / `existing modes identical: 15/15` |
| 9 | Typecheck | `node .../tsc -p tsconfig.json --noEmit` (sandbox TS 6) | 1 error, `test/facetrack.test.ts(67,92) TS2769`, sandbox-TS-version only (owner's TS 5.9 list had none) |
| 10 | Full regression before this run's last test additions | `node --test test/*.test.ts` | `# tests 542 / # pass 541 / # fail 0 / # skipped 1` |
| 11 | Full regression after this run | `node --test test/*.test.ts` | `# tests 594 / # pass 593 / # fail 0 / # skipped 1` (after AGENT loop T1-T12) |

## IMPLEMENTED + NOT VERIFIED
- Real face / active-speaker detection (`tools/face_samples.py`, advisor): sandbox OpenCV has no detector; every face in tests is FAKE.
- HUD / minimap / kill-feed / health / ammo zones: assumed default positions, never checked on a real game frame.
- `src/styles/recipes.ts` (content-specific styles, context-aware SFX/music/B-roll cues): logic tested, NOT wired into render; effect on retention or output quality is not measured.
- Content detection and quality gate accuracy on real transcripts/videos (only synthetic fixtures).
- Per-destination metadata policy applied on real provider uploads (fake servers only).
- Stacked-layout captions/QC safe zones (patch not applied, so not tested end to end).

## PENDING (in scope, not blocked by device)
- Apply `docs/filters.proposal.patch` (needs owner approval) + render hook that passes `tiles` and lets the advisor return `multi_stack`.
- Render hook that applies `applyRecipe` / `cuePlan` / `wantsBroll` (owner approval; fills only options the owner left unset).
- Surface the framing advisor decision in the clip manifest/UI (today only an `info` log line).
- AI upscale / 2560x1440 output (secondary, NOT_IMPLEMENTED).

## BLOCKED BY DEVICE / OWNER / PROVIDER
- Termux/phone: face tracking on device, STT accuracy, render speed, `npm run verify:device -- --capture` on a live source (device).
- Real YouTube upload after Main reconnect; OAuth app to Production (owner/provider).
- Meta HTTPS callback / domain, TikTok audit, multi-account TikTok (owner/provider).
- Kick live capture and upload: no documented upload endpoint, no credentials (provider).
- Ollama, Groq/Pexels live calls, Bluesky live test, cloud deployment (owner/device).
- LICENSE choice (owner).
- Windows-only `test/adapters.test.ts` failures on a Windows run (owner runs Termux/Linux; Linux sandbox green).
