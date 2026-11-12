# Pending checklist (from the owner files: Features yt-clips, Prompt, Yt-copyright, improvement)

`[x]` done and covered by a test, `[ ]` pending, `[-]` deliberately NOT built (reason given).

## Features file (50 items) -> see docs/FEATURES_STATUS.md
- [x] 49 of 50 built. 
- [ ] 31 B-roll search: needs a stock-footage source (API key) or the owner's own clip folder.

## Real-world verification (sandbox has no phone / YouTube / cloud) - UNVERIFIED
- [ ] Asli YouTube upload after reconnect (OAuth app must be in Production, tokens die in 7 days in Testing)
- [ ] Phone: face tracking needs opencv (missing on Termux), render speed
- [ ] Deploy on Render / Railway / Replit / Fly with the new files (owner must paste the first error line if it fails)
- [ ] Bluesky adapter against the real service (fake-server tested)
- [ ] Hindi STT accuracy with Groq whisper-large-v3 on his audio

## From `improvement`
- [ ] Hardware encoding / parallel render (render is slow on phone)
- [ ] Chat-replay based highlight detection (live streams)
- [ ] Analytics API -> learn which clips work
- [ ] A/B title test by CTR
- [x] Gameplay + facecam layout, killfeed, Telegram notifications, multi-channel, Kick/Twitch/YouTube sources
- [ ] Token encryption mandatory (YT_CLIPS_SECRET_KEY missing -> plaintext 0600 file today)
- [ ] LICENSE: the OWNER must choose the licence (nothing chosen for him)

## From `Yt-copyright` / `Prompt`
- [x] Unlisted-first upload, public gate, claim/ownership checks, "Claim aaya" button
- [-] Fingerprint-breaking filters (mirror/flip, pitch shift, micro-silences, colour shifts to beat Content ID): NOT built. They exist to evade copyright detection of other people's content; the tool only adds real transformation (captions, zoom, commentary) and uses unlisted-first checks.
- [-] "Auto-delete on claim + blacklist source": claims are surfaced to the owner (Claim aaya) instead of silent deletion.

## This round (owner clip_059 + friend message)
- [x] Short source (<= 75 s) -> exactly ONE clip (whole video, captions+effects, no cutting)
- [x] On-screen title cleaned of foreign letters; AI metadata (Groq gpt-oss) empty-answer fix
- [x] Tab bar: second "Studio" button no longer breaks navigation (blank #undefined page); select boxes no longer collapse to blank
- [x] Insights/Schedule/etc. no longer fail silently: red banner + Retry (+ "Reconnect" hint)
- [-] Publish queue auto-fill: clips go to the queue automatically when `automation.requireReview` is off; with review on (default) they wait for the owner's Approve on purpose
