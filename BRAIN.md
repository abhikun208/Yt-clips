# BRAIN.md — design decisions (short)
Pipeline: ingest -> analyze (whole timeline) -> candidates -> raw clip -> edited short (NEW folder) -> QC -> metadata -> publish state machine (gated).
Data lives under `data/` (gitignored): source_videos (read-only copies), raw_clips, edited_shorts, manifests, thumbnails, yt-clips.sqlite.
Safety: `gates.*` default false. Publishing/comments/public visibility need the owner to edit `data/config.json`.
No destructive DB ops: migrations are CREATE IF NOT EXISTS only. Outputs never overwritten (unique output ids, `.part` + rename).

## Accounts model (2026-11-17)
`destinations` table = one row per publishing account, id `yt:<channelId>|fb:<pageId>|ig:<igId>|tt:<openId>`, points at an encrypted secret (never holds tokens). syncDestinations derives status from real secrets; enabled flag is the owner's. Logins only ADD (webauth.guardReplacement, Meta page merge, tiktok-<openId>). advance() blocks DESTINATION_DISABLED per destination. Code: src/accounts/destinations.ts.
