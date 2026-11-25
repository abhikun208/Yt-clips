# Architecture (short)
Pipeline: source import → analysis/transcription → candidates → render (ffmpeg) → QC → metadata → upload queue → verify → analytics → learning. Code: src/pipeline.ts (stages), src/edit/* (render/jumpcut/encoder), src/seo/* (metadata), src/review/* (thumbnails/ZIP), src/publish/* (machine, adapters, oauth, secrets, scheduling), src/accounts/destinations.ts (registry + source mappings), src/ai/* (providers, health, autodetect/self-heal), src/server/app.ts + ui.html (HTTP API + dashboard), src/cli.ts. Storage: node:sqlite with additive migrations (src/db.ts, v1–v15, never destructive), secrets AES-256-GCM under data/secrets. See BRAIN.md for detail, OAUTH_ARCHITECTURE.md and PUBLISHING_STATE_MACHINE.md.

## Additions (2026-11-25)
- Moments: `analysis/moment-detector.ts` (events → clusters → pattern → scored tiers) → `analysis/moments-store.ts` (table `moments`, migration v23, `editorialQc`) → merged into candidates in `analyzer.ts`. Live: `watcher/live-bridge.ts` joins chunk seams. `util/resources.ts` throttles heavy lanes.
- Edit: `edit/dub.ts` runs after render (English → Hindi dub, QC re-run).
- Publish: `accounts/sourcepolicy.ts` decides which source may go to which channel/platform; `publish/audit.ts` reports why nothing is public. Owner switches (PUBLISH_MODE, AUTO_APPROVE) are read only from `.env`.
