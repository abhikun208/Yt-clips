# Feature comparison matrix (Phase 6) — researched 2026-10-20/21

Sources were fetched live. Where a page did not state something, it is marked "not stated". Nothing here bypasses a subscription, API key, quota or access control: premium-style features are re-implemented with local/open-source tools (FFmpeg, OpenCV) or are marked limited/blocked.

## Reference findings (verified from the pages)
| Reference | What it actually is | License | Takeaway |
|---|---|---|---|
| ssemble.com | Paid AI clipping SaaS: AI clipping, auto-curation, hook title & CTA, face tracking, sports mode, game-video layout, auto captions + 30+ language translation, schedule/post to TikTok/YouTube/IG, channel automation, API + MCP. Plans $6–$40/mo (credits). Free tier: not stated. | proprietary | Feature ideas only. Their hosted models/credits cannot be "made free"; we implement local equivalents where feasible. |
| github.com/ssembleinc | 8 repos: `ssemble-mcp-server` (JS, MIT), `n8n-nodes-ssemble` (JS, MIT) + 6 forks of MCP lists. Both original repos are API clients for the paid Ssemble service. | MIT | Nothing to port: they only call the paid API (would require their credits). Not integrated. |
| github.com/Jakeschincariol | 8 repos: Claude-skill collections (`unhinged-claude-skills`, `claude-illegal-codes`, `promptmaster-skill`), `Influencer-Clone` ("copies influencer viral videos", Python), `Nucleus`, `jakes-cyber-yournucleus`. No licenses shown. **No multi-platform social-media tooling found.** | not shown | Owner's expectation (social-media features) not met by this account. `Influencer-Clone` copies other creators' videos → copyright/authorization risk, deliberately NOT integrated. |
| harry0703/MoneyPrinterTurbo | Python, topic→script→footage→TTS→subtitles→video generator; WebUI/API/CLI; Edge-TTS free; faster-whisper subtitles; 9:16/16:9/1:1; stock footage via Pexels/Pixabay keys; bundled music of YouTube origin (repo itself warns about copyright). License file linked, type not stated on page. | not stated on page (check LICENSE before copying) | Different product (generates new videos, doesn't clip). Ideas reused: faster-whisper STT adapter, Edge-TTS (optional), multi-aspect export. No code copied. |
| autocap.in | Indian-language captioning SaaS (12 Indian languages, word-by-word reveal, per-word timing, burned MP4 + SRT/VTT, free plan = 60s clips). Template page lists 191 templates, but only names/tags are readable (e.g. Bold, Build, Caps, Box, Karaoke, Glow, Outline, Chip, Gradient, Typewriter); visuals described for only 3 (a word-build style with coral active word / grey upcoming, one-word, pixel-word). | proprietary | Their template designs/assets are NOT copyable (not provided, proprietary). We built **72 original presets** (12 styles × 6 palettes) covering the same tag vocabulary, plus script-aware fonts for Hindi + 9 other Indian scripts. SRT/VTT export done. Their hosted multi-language STT/translation is not reproduced. |
| mcpmarket.com/hub | A product for versioning/syncing agent skills & MCP tools. No video/social servers listed on the page. | n/a | Nothing to integrate. |
| ssemble comparison pages (Opus, VEED, CapCut, Vizard, Descript) | Marketing tables; feature columns for competitors were unreadable in the fetched text. Stated: Opus/Vizard free plans have watermark; credits ≈ 1/min; CapCut Pro $9.99–19.99; VEED $12–29; Descript $16+. | n/a | Used only as a checklist of feature *names*: AI clipping, auto captions, auto posting, hook title & CTA, game video, caption translation, B-roll, auto zoom, sound effects, background music. |

## Feature → our implementation
| Feature | Reference | Free/OSS feasibility | Status here | Evidence |
|---|---|---|---|---|
| AI clipping of full timeline | Ssemble/Opus | Heuristic: FFmpeg audio energy+scene+silence (+optional transcript) | DONE (heuristic, not learned) | test/analysis.test.ts, e2e |
| Intro/outro exclusion (detected, overridable) | Ssemble | FFmpeg black/silence/scene | DONE | boundaries test, real fixture |
| Auto captions + word-by-word styles (72 presets, 5 modes, Indian scripts) | all / autocap | libass (FFmpeg) + STT adapter | DONE (rendering, verified visually + tests). STT: adapter DONE & tested with a fake engine; real faster-whisper model NOT tested here | test/captions.test.ts, test/adapters.test.ts |
| Caption translation 30+ langs | Ssemble | Needs MT model/API | NOT IMPLEMENTED | — |
| Face tracking reframe | Ssemble | OpenCV Haar | PARTIAL (basic; centered fallback recorded in manifest) | tools/face_center.py |
| Sports/ball tracking | Ssemble | heavy CV | NOT IMPLEMENTED | — |
| Hook title overlay | Ssemble | ASS animated title | DONE | real frame inspected |
| Color grade, vignette, glow, zoom, fades, sharpen | CapCut | FFmpeg | DONE | manifest + render |
| Auto zoom | CapCut | zoompan | DONE (slow push-in) | filters test |
| Speed ramp / beat-sync effects | CapCut | FFmpeg + beat detection | NOT IMPLEMENTED | listed as not applied in every manifest |
| Voice enhance, noise reduction, loudness -14 LUFS | Descript Studio Sound-like | afftdn+compressor+loudnorm | DONE | QC measured -14.1 LUFS |
| BGM with ducking | CapCut | sidechaincompress | DONE only when owner puts licensed music in `assets/music/` (none bundled) | filters test |
| Hinglish SEO titles/desc/tags/hashtags | Ssemble (LLM) | Template (offline); LLM adapter possible | PARTIAL: template-based, honest, no LLM | metadata test |
| Thumbnail | Ssemble | FFmpeg frame + text, validated | DONE | e2e test |
| Scheduler (caps, gaps, quiet hours, measured vs baseline) | Ssemble | pure logic | DONE (logic). Analytics ingestion from platforms: NOT implemented | scheduler test |
| Upload state machine, unlisted-first, remote verify, idempotency | — | logic | DONE with DryRun adapter | publish tests |
| Real YouTube / Instagram / TikTok / Facebook upload | Ssemble | Official APIs need owner OAuth + app review | BLOCKED: no adapter shipped; needs creds + explicit authorization | gates OFF |
| Channel monitoring / yt-dlp download (new uploads + backlog, bounded) | Ssemble | yt-dlp | DONE as adapter, tested with a fake yt-dlp; real yt-dlp/network NOT tested here | test/adapters.test.ts |
| Comment classify + draft replies (approval mode) | — | rules | DONE; posting adapter NOT implemented | comments test |
| Clip rewards, game-video layout | Ssemble | n/a | NOT IMPLEMENTED / out of scope | — |
