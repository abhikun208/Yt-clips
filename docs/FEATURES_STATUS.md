# Feature status (replaces the owner-uploaded reference file "Features yt-clips")

Verified = covered by an automated test. Phone / real-site behaviour is UNVERIFIED unless stated.

| # | Feature | Status | Where |
|---|---------|--------|-------|
| 1-5 | Imports (upload, YouTube video/channel/playlist, Twitch/Kick, Vimeo) | done (real sites UNVERIFIED) | `src/sources/` |
| 6 | Language selection | done | channel `language`, captions Roman Hinglish |
| 7 | Project dashboard | done | `src/server/ui.html` |
| 8 | Processing time range | done (`10:00-25:00`) | `parseRange`, source add box |
| 9 | Clip entire video | done: whole video is analysed (no 20-min splitting needed) | `analyzer.ts` |
| 10 | Multi-language audio track | done (`audioLang`) | `youtube.ts` |
| 11-14 | Transcription, scene detection, curation, viral ranking | done | `analysis/` |
| 15-16 | Clip length + max clips (1-12) | done, also per channel | reanalyze API/UI, channel settings |
| 17 | Original mode / no clipping | done (`whole`) | reanalyze UI |
| 18-20 | Queue, progress, failure + retry | done | `db.ts`, pipeline map |
| 21-24 | Cut editor, timeline trim, restore words, undo/redo | done (words kaato panel) | `ui.html`, `planManualCuts` |
| 25 | Face tracking | done, needs python+opencv (auto-installed on PC/Docker; missing on his phone, falls back to centre crop) | `tools/face_*.py` |
| 26-30 | Layouts Auto / Fill / Fit / 1:1 / blur or colour background | done | render dialog, `edit.reframe`, `edit.bgColor` |
| 31 | B-roll search | done, opt-in: Pexels free key + `edit.broll:true` (UNVERIFIED live); no key = own close-up inserts | `edit/broll.ts`, `edit/retitle.ts` |
| 32 | Transition effects | done (none / fade / flash / zoom) | render dialog |
| 33 | Sound effects | done (synthesised whoosh + pops, `edit.sfx`) | `filters.ts` |
| 34-35 | Video effects, zoom | done | `vfx.ts`, `edit/beats.ts` |
| 36 | Highlight captions + position | done (emphasis words, position top/center/bottom) | `captions.ts` |
| 37-40 | Meme hook, game overlay (facecam stack / killfeed), hook title, CTA | done | `edit/` |
| 41 | Background music | done (own files win; else built-in synthesised pads, `edit.autoMusic`) | `music.ts`, `synthmusic.ts` |
| 42-44 | Captions, templates (384), translation | done | `captions.ts`, `ai/translate.ts` |
| 45 | AI title / description / hashtags | done (needs one AI key for non-generic; falls back to rules) | `seo/` |
| 46 | Export | done (zip with mp4, thumbnail, srt, metadata) | `review.ts` |
| 47-48 | Account connect + publish | YouTube done; TikTok/Instagram/X modules exist, UNVERIFIED on real accounts | `publish/` |
| 49 | Calendar + scheduling | done | `/api/calendar` |
| 50 | Channel automation (length, clips/video, check 6h/12h/24h/weekly, min viral) | done | channel settings |
