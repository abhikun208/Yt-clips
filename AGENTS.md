# AGENTS.md — start here (any AI/agent resuming this repo)

yt-clips: self-hosted video → ranked clips → edited Shorts → metadata → gated publish → analytics. Zero runtime npm deps (Node >=22.18).

## Resume procedure
1. Read `PROGRESS.md` top to bottom. Done when you can state the first item under "NEXT STEP".
2. Run `npm test` and `tsc -p tsconfig.json --noEmit` (or the sandbox typecheck noted in PROGRESS). Done when tests show `fail 0` and typecheck prints nothing.
3. Work the "NEXT STEP" list in order. For each item: implement → add a test → run the full suite → update `PROGRESS.md` → commit and push to `main`. An item is done when its test passes against the real code path (a fake server counts as "fake-tested", say so in PROGRESS).
4. Before stopping, `git status -sb` shows `main...origin/main` with no local changes.

## Pointers (read only when the trigger fires)
- Architecture and decisions → `BRAIN.md` when changing pipeline stages, DB schema or the state machine.
- Owner's original requirements → `Prompt` when a design question is unclear.
- Platform research and what was verified → `docs/FEATURE_MATRIX.md` when touching a platform adapter.
- Deploy → `DEPLOY.md` when touching Docker/systemd/PaaS files.

## Hard guardrails (owner's rules)
- Gates (`publishEnabled`, `publicVisibilityAllowed`, `commentsAutoPost`) stay false in code and are changed only by the owner in `data/config.json`; no API or env var may flip them.
- DB migrations are additive (`CREATE IF NOT EXISTS`); data is never reset.
- Secrets never reach logs or API responses.
- PROGRESS.md marks a feature DONE only with a passing test or a real run; write "fake-tested" or "unverified" otherwise.

## Conventions
- Type-stripping Node: no enums, no constructor parameter properties.
- Tests in `test/*.test.ts` use `node:test`; fake external services live in `test/fake*.ts`.
- Reply to the owner in Hinglish.
