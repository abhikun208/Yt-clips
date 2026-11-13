# Pending checklist (from the owner files: Features yt-clips, Prompt, Yt-copyright, improvement)

`[x]` done and covered by a test, `[ ]` pending, `[-]` deliberately NOT built (reason given).

## Features file (50 items) -> see docs/FEATURES_STATUS.md
- [x] 49 of 50 built. 
- [x] 31 B-roll: built (Pexels, opt-in; live download UNVERIFIED)

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
- [x] Speed option: exactly one of 1.05 1.06 1.07 1.08 1.09 1.10 (or 1 = off), default 1.05; ranges/other values rejected by API (400); applied after captions so words stay in sync
- [x] On-screen title: black/white strip glued to the top edge, whole clip start->end, contrasting text, up to 2 lines sized to the title; CTA moves under it
- [x] SEO package per clip: 50 keywords, tags fitted to YouTube's 500 chars, 50 hashtags (15 real #tags in the description, rest as plain words), 10 highlights, real YouTube search phrases (autocomplete); junk words (bhai/gaya/bees...) filtered everywhere
- [x] Description about/highlights forced to Roman Hinglish (English answer -> one rewrite request -> else template Hinglish)
- [ ] UNVERIFIED on device: real autocomplete results, Hinglish quality of the AI rewrite, title strip look on the phone's real video
- [ ] TubeBuddy/vidIQ: not integrated (paid, login-only, no public API); YouTube search autocomplete + the clip's own keywords are used instead
- [x] Title is printed AFTER the AI has watched the finished clip (frames + speech): clip renders without title, metadata step writes the title, `finishClip` prints it as the strip in one light pass (audio copied, QC re-run); hook fallback if the AI did not answer
- [x] Vision for Groq keys: Groq's text model (gpt-oss) cannot see images -> the same key's vision model is auto-detected (GROQ_VISION_MODEL overrides); the "no AI could describe" warning now says WHY
- [x] SEO relevance: AI tags/hashtags replace mis-heard transcript words; autocomplete only for 2-3 word topics (no more 'pani puri' for 'pani')
- [x] B-roll (Pexels stock cutaways, 1.6 s x up to 3 in the upper panel, off by default: `edit.broll:true` + PEXELS_API_KEY); without a key the clip's own close-up inserts are used
- [x] Start-up auto-install now also covers faster-whisper (PC/VPS/cloud; Termux uses whisper.cpp)
- [ ] UNVERIFIED on phone/cloud: Groq vision model call, Pexels download, finish pass timing on Termux
