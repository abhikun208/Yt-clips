# BRAIN.md — design decisions (short)
Pipeline: ingest -> analyze (whole timeline) -> candidates -> raw clip -> edited short (NEW folder) -> QC -> metadata -> publish state machine (gated).
Data lives under `data/` (gitignored): source_videos (read-only copies), raw_clips, edited_shorts, manifests, thumbnails, yt-clips.sqlite.
Safety: `gates.*` default false. Publishing/comments/public visibility need the owner to edit `data/config.json`.
No destructive DB ops: migrations are CREATE IF NOT EXISTS only. Outputs never overwritten (unique output ids, `.part` + rename).
