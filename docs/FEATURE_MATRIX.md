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
| Beat effects (punch-zoom at audio peaks) | CapCut | FFmpeg zoompan + energy peaks | DONE (peaks, not BPM) | test/beats.test.ts |
| Speed ramp (slow-mo at audio peak) | CapCut | FFmpeg trim/setpts/atempo | DONE (slow-mo only; no speed-up of boring parts) | test/ramp.test.ts |
| Voice enhance, noise reduction, loudness -14 LUFS | Descript Studio Sound-like | afftdn+compressor+loudnorm | DONE | QC measured -14.1 LUFS |
| BGM with ducking | CapCut | sidechaincompress | DONE only when owner puts licensed music in `assets/music/` (none bundled) | filters test |
| Hinglish SEO titles/desc/tags/hashtags | Ssemble (LLM) | Template (offline); LLM adapter possible | DONE: template by default; optional OpenAI-compatible LLM via env (fake-tested only) | metadata test |
| Thumbnail | Ssemble | FFmpeg frame + text, validated | DONE | e2e test |
| Scheduler (caps, gaps, quiet hours, measured vs baseline) | Ssemble | pure logic | DONE; analytics via owner CSV import. Auto-pull from platform APIs: NOT implemented | scheduler test |
| Upload state machine, unlisted-first, remote verify, idempotency | — | logic | DONE with DryRun adapter | publish tests |
| Real YouTube / Instagram / TikTok / Facebook upload | Ssemble | Official APIs need owner OAuth + app review | YouTube adapter DONE but fake-Google-tested only; Instagram/TikTok/Facebook BLOCKED (creds/app review) | gates OFF |
| Channel monitoring / yt-dlp download (new uploads + backlog, bounded) | Ssemble | yt-dlp | DONE as adapter, tested with a fake yt-dlp; real yt-dlp/network NOT tested here | test/adapters.test.ts |
| Comment classify + draft replies (approval mode) | — | rules | DONE; posting adapter NOT implemented | comments test |
| Clip rewards, game-video layout | Ssemble | n/a | NOT IMPLEMENTED / out of scope | — |

## Session 4 review (2026-10-23): features taken from the owner's reference list
| Reference | What it offers (as read) | Taken / not taken |
|---|---|---|
| JayWebtech/autoshorts | LLM-based short picking, onboarding | Taken: LLM **re-ranks** our own candidates (never asks the model for timestamps), setup checklist on Home. Not taken: its pipeline/code. |
| nejib1/Free-LLM, mnfst/awesome-free-llm-apis | Lists of free/OpenAI-compatible LLM providers | Taken: provider presets (Groq, Gemini, OpenRouter, Mistral, Ollama, LM Studio) + fallback chain + keyless localhost. Honest: only Groq docs were read; the other base URLs/models are unverified starting points; no provider was called live. |
| debpalash/VoiceStudio | Local TTS/voice cloning/dubbing studio | NOT implemented (heavy models, licence review needed). Dubbing/TTS stays a future item. |
| Jakeschincariol/youtube-agent-skill | Agent-skill for YouTube workflows | Read in session 3; no code copied; its ideas (SEO + analytics loop) are covered by existing modules. |
| ssemble.com, autocap.in | Clipping/caption SaaS | Already in the matrix above. New this session: jump cuts (silence removal), progress bar, keyword punch-zoom, flash transitions, LUT/grain/particles/light-leak, review inbox, export package. Not copied: their proprietary templates/assets. |

| Feature | Status | Evidence |
|---|---|---|
| Local keyless text intelligence (keyphrases, hook, titles/desc/tags, sentence-snapped clip edges) | DONE (heuristic) | test/local.test.ts |
| Cinematic curves per mood / owner .cube LUT, film grain, drifting dust particles, light leak, flash transitions | DONE | test/vfx.test.ts + frame inspected |
| Measured visual change (1-SSIM vs plain reframe) + coverage vs 40% target in each manifest | DONE | test/vfx.test.ts |
| Jump cuts (dead-air removal, captions re-timed), animated progress bar, keyword punch-zoom | DONE | test/jumpcut.test.ts (real ffmpeg + full render) |
| LLM rerank + keyless local endpoints + fallback chain | DONE; fake-server tested only | test/llmchain.test.ts |
| Review inbox, metadata edit, thumbnail frame, ZIP export, re-render variants, `requireReview` | DONE | test/review.test.ts, test/dashboard.test.ts |
| Tabbed dashboard, setup checklist, live activity, Autopilot panel | DONE; loaded in real headless Chromium (desktop + 390px phone), no JS errors | test/dashboard.test.ts + screenshots |
| Dubbing / TTS / voice cloning | NOT implemented | — |
| Caption translation | NOT implemented | — |

## Session 5 (multi-channel, schedule, platforms, security)
| Feature | Status | Evidence |
|---|---|---|
| Multiple channels with separate schedule, tokens, branding, platform list | DONE | test/channels.test.ts |
| Cross-channel stagger + per-channel daily caps | DONE | test/channels.test.ts |
| Telegram / Discord / Mastodon direct posting | DONE; fake-tested only | test/direct.test.ts |
| Manual post tasks for Instagram, Facebook, TikTok, X, LinkedIn, Pinterest, Snapchat, Threads, Bluesky, Reddit | DONE | test/direct.test.ts |
| Password/ID login automation | NOT built on purpose (ToS, bans, 2FA, plaintext passwords) | — |
| Encrypted credential vault, auto key | DONE | test/direct.test.ts |
| Hardware encoding + parallel lanes | DONE (probe + fallback; GPU paths untested) | test/encoder.test.ts |
| Chat/heatmap highlight signals, gaming profile, gamer-stack layout | DONE; real download untested | test/signals.test.ts |
| Real-world smoke command | DONE (owner runs) | test/smoke.test.ts |
| Retention from YouTube Analytics API + learned category prior | DONE; stub tested (CTR not exposed by Google) | test/youtube2.test.ts |
| Title A/B by rotation, funnel comment (pin = manual) | DONE; weak statistics, stub tested | test/youtube2.test.ts |
| Caption translation en/hi | DONE; stub tested | test/translate.test.ts |
| Killfeed OCR signal | DONE; real tesseract on synthetic frames | test/killfeed.test.ts |
| Per-word caption font fallback | DONE | test/captions.test.ts |
| Real-service tests (owner-run) | WRITTEN, not executed by author | test/real/real.test.ts |
