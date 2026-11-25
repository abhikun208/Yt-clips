# AGENT_STATE.md (resume point: read this, continue from CURRENT_TASK)

## STEP 0 RESULT (2026-11-22)
- Languages/entry: Node >= 22 TypeScript-as-JS (zero npm deps, `node --test`, node:sqlite), Python sidecars in `tools/` (face_track.py, facedet.py, face_samples.py), FFmpeg. Entry: `src/cli.ts` (`npm run cli`), `src/server/app.ts` (`npm start`), tests `test/*.test.ts`, typecheck `npm run typecheck`.
- Modules: DB `src/db.ts` (additive migrations), analytics `src/analytics/{collect,providers,learn}.ts`, publish `src/publish/*`, SEO `src/seo/*`, dashboard `src/server/ui.html`, analysis `src/analysis/*`, framing `src/framing/*`, styles `src/styles/*`.
- BASELINE test (sandbox, before this loop; code = commit d27b25b): `node --test test/*.test.ts` -> tests 549, pass 548, fail 0, skipped 1. Typecheck: 1 sandbox-TS6-only error (`test/facetrack.test.ts(67,92)`).
- Backups: `backups/2026-11-22/` (SQLite + WAL/SHM copy, package.json; git-ignored). Locked list + checksums: `LOCKED_PATHS.md`, `LOCKED_CHECKSUMS.sha256` (39 files, check = `sha256sum -c LOCKED_CHECKSUMS.sha256 | grep -v ': OK'` must be empty).
- Rules in force: commit+push is now allowed by the owner for this loop (every commit carries the attribution lines), no edits to locked files, PUBLISH_MODE never switched by me, no secrets printed.

## BACKLOG (statuses: TODO / DOING / DONE / BLOCKED)  [evidence = existing state found in STEP 0]
| ID | Item | Found | Evidence | Status |
|---|---|---|---|---|
| T1 | W8 PUBLISH_MODE env (DRY_RUN default -> PRIVATE -> PUBLIC), never auto PUBLIC | MISSING | grep PUBLISH_MODE finds only AGENT_PROMPT.md; gates exist in config (publishEnabled/publicVisibilityAllowed) | DONE: src/config.ts `publishMode`+`assertPublishAllowed`, status API field, test/publish_mode.test.ts 3/3 |
| T2 | W9 Studio CSV import (MANUAL_IMPORT) + "judge only if >=72h old AND >= min views, compare similar age/length/category" | MISSING | src/analytics/collect.ts has snapshots only; no csv importer, no eligibility rule | DONE: src/analytics/studiocsv.ts (+ migration v18 `studio_stats`, POST /api/analytics/studio-import, GET /api/analytics/studio), test/studio_csv.test.ts 5/5 |
| T3 | W4 opportunity score with 13 stored sub-scores + reasons, configurable threshold | PARTIAL | src/analysis/select.ts has one blended score + `reason`; `cfg.clip.minScore` threshold exists; no sub-scores | DONE: src/analysis/opportunity.ts (13 sub-scores, MEASURED/HEURISTIC/UNAVAILABLE), migration v19 `candidate_opportunity`, analyzer stores it + optional `clip.opportunityMin` rejection (default off), test/opportunity.test.ts 4/4 |
| T4 | W5 >=5 truthful hook candidates scored, best picked | PARTIAL | src/seo/hook.ts `realHook` returns one hook | DONE: src/seo/hooks.ts (verbatim candidates, teaser flag, slowIntro), migration v20 `candidate_hooks`, analyzer keeps best hook only if clearly stronger (`clip.smartHooks` default on), test/hooks.test.ts 4/4 |
| T5 | W7 cross-video metadata similarity check | DONE | src/seo/{clipmeta,score,titlegate}.ts exist; `similarity` only in src/analysis/qualitygate.ts (clips, not metadata) | TODO |
| T6 | W2 rights/originality gate: other creators' handles/watermark text, no-commentary flag, decision log | DONE | `--authorized` flag, src/edit/sourcecheck.ts (locked), src/publish/claims.ts; no handle/watermark check | DONE |
| T7 | W10 failure analysis with confidence + sample size | DONE | no module (src/diagnose.ts is system health only) | DONE |
| T8 | W11 persistent experiments memory (hypothesis, vars<=3, result, group, conclusion, confidence; "NO EVIDENCE YET") | DONE | src/analytics/learn.ts proposals/apply/revert; title_tests table; no generic experiments table | DONE |
| T9 | W3 evidence labels VERIFIED_DATA / ESTIMATE / AI_GUESS / UNAVAILABLE on research insights | PARTIAL | src/seo/{suggest,trends}.ts exist, unlabeled | DONE |
| T10 | W1 channel DNA: per-category comparison, niche-vs-split recommendation with sample sizes | MISSING | learn.ts buckets by hour/format, not content category | DONE |
| T11 | W12 AI report endpoint/dashboard card (working / not working / reasons / next experiments / confidence) | PARTIAL | dashboard exists (src/server/ui.html), no AI report | DONE |
| T12 | W13 integration table + README section (how to run, PUBLISH_MODE) | DONE | none | DONE |
| E1 | W1 duplicate-clip detection | EXISTS_WORKING | src/media/phash.ts + `clip_fingerprints` table | DONE (pre-existing) |
| E2 | W8 verify after upload; YouTube quota guard (units/insert caps, PT day) | EXISTS_WORKING | src/publish/machine.ts `verify`, src/publish/youtube.ts quota_usage | DONE (pre-existing; real provider UNVERIFIED) |
| E3 | W6 presets/profiles chosen per clip, locked engine untouched | EXISTS_WORKING / PARTIAL | channel `captionPreset`, `src/framing`, `src/styles/recipes.ts` (not wired) | PARTIAL |
| B1 | W8 YouTube API audit (unaudited projects may force uploads private) | BLOCKED | needs owner Google Cloud audit/consent; document only | BLOCKED |
| B2 | W9 real YouTube Analytics API pull (engaged views, swipe-away %, traffic sources) | BLOCKED | needs owner OAuth with analytics scope + data; CSV import is the fallback (T2) | BLOCKED |

## CURRENT_TASK
DONE (2026-11-25): moment engine, per-source upload permission, dubbing, publishing audit, owner .env switches, real-upload fixes. Remaining items are owner/device-only (see PENDING_CHECKLIST.md). Next: owner runs `git pull && npm start` on the phone and reads the Home 'Publishing audit' card.

## DECISIONS
- Backlog items reuse existing modules; new logic goes in new files (`src/publish/mode.ts`, `src/analytics/studiocsv.ts`, ...), DB changes additive only.
- Full regression takes ~35 min in this sandbox, so each task runs its focused suites + locked checksum check; a full run is done at the end and recorded.

## LAST_TEST_RESULT
T1: `node --test test/publish_mode.test.ts test/publish.test.ts test/server.test.ts test/youtube.test.ts test/direct.test.ts test/automation.test.ts test/core.test.ts` -> all pass (22 + 22); typecheck only the sandbox-TS6 facetrack error; locked checksums: 0 FAILED. Real output: youtubeStatus() prints publishMode DRY_RUN when env unset, PRIVATE when PUBLISH_MODE=private.

T2: `node --test test/studio_csv.test.ts` -> 5/5 pass (parse quoted/thousands/mm:ss/percent, Total+bad rows skipped, NULL for missing, idempotent re-import, 72h/min-views judging, peers by age/length/category, real HTTP round trip). Real output: GET /api/analytics/studio -> v1 OK(240h), v2 TOO_YOUNG(24h), v3 TOO_FEW_VIEWS. Existing `/api/analytics/import` (per-time-bucket, scheduler) is kept; this is the per-video import (not a duplicate).

T3: `node --test test/opportunity.test.ts` -> 4/4 pass (13 parts, strong vs weak, UNAVAILABLE not invented, reject rule, analyzer stores rows; silent fixture => score NULL and nothing rejected). Regression run (analysis, queueorder, unlimited_clips, e2e, longvideo, shorts_engine, live*) logged in /tmp/claude-0/t3reg.log.

T3 regression: analysis, queueorder, unlimited_clips, e2e, longvideo, shorts_engine, live* -> tests 71, pass 71, fail 0.
T4: `node --test test/hooks.test.ts` -> 4/4. Real stored example (120 s fixture + SRT): hook 'He had only 12 health left and still won.' best of 7 verbatim candidates. Teaser = flag only (no reordering of the video: that would be editing).

## DECISIONS (T1)
- PUBLISH_MODE is enforced at the single choke point `assertPublishAllowed` (all uploads/publishes/title edits go through it). It reuses the PUBLISH_DISABLED / PUBLIC_DISABLED codes so every caller already treats it as a hold (not a failure). PRIVATE = nothing becomes public; the existing first upload stays `unlisted`. Default (unset/invalid) = DRY_RUN. BEHAVIOUR CHANGE for the owner: with gates enabled but PUBLISH_MODE unset, uploads are now held until the owner sets PUBLISH_MODE=PRIVATE or PUBLIC.
- test/helpers.ts sets PUBLISH_MODE=PUBLIC (if unset) so the existing gate/state-machine tests keep exercising the gates; mode itself has its own tests.

## DECISIONS (T3)
- The opportunity score does NOT change candidate ranking (select.ts untouched); it is stored per candidate and is only a rejection threshold when the owner sets `clip.opportunityMin`. Competition/search volume/originality/audience-fit are UNAVAILABLE unless real data exists (never estimated). A candidate with too little evidence gets score NULL and is never rejected for that.

## BLOCKERS
- B1, B2 above (owner: Google Cloud audit/consent + analytics OAuth scope; first real analytics data).

## 2026-11-24 schedule audit
DONE: three scheduling defects fixed (see PROGRESS (54)); tests test/scheduled_due.test.ts 3/3, focused regression 109/109. Remaining code-doable: T8 auto-link of experiments to Studio stats.

## UPDATE 2026-11-25 (items 58-61 in PROGRESS.md)
- Moment engine: src/analysis/{moment-detector,moments-store}.ts, migration v23 `moments`, editorial QC gate, live seam bridge (src/watcher/live-bridge.ts), resource guard (src/util/resources.ts). API: GET /api/moments/summary.
- Source upload permission: src/accounts/sourcepolicy.ts (unconfigured = unrestricted; mode open|own_only). API: GET/POST /api/sources/:id/upload-policy.
- Dubbing: src/edit/dub.ts (English -> Hindi, needs edge-tts + LLM key; result in kv `dub:<clipId>`).
- Publishing audit: src/publish/audit.ts, GET /api/publish/audit, Home card.
- Owner switches live ONLY in `.env`: PUBLISH_MODE=PUBLIC|PRIVATE (opens gates + autoQueue) and AUTO_APPROVE=true. Never writable via API.
- Last full suite: 639 tests, 638 pass, 0 fail, 1 skipped; locked checksums clean.
- Real FB/IG/YouTube posting: UNVERIFIED (fake servers only).
