# Platform capability matrix (2026-11-19)
Source of truth for what is implemented: `src/publish/direct.ts` (PLATFORMS), `youtube.ts`, `meta.ts`. "API facts" are from the app's own notes/earlier research and must be re-checked against each provider's current docs before relying on them. Nothing here was run against a real account by CI.

| Platform | Mode in this app | Account identity check | Scheduling by API | Test status |
|---|---|---|---|---|
| YouTube Shorts | api-upload (resumable, OAuth per channel) | `channels.list mine=true` before every upload + remote verify | Yes (private + `publishAt`) | MOCK-TESTED (fake Google). Real: owner must reconnect Main |
| Facebook Reels (Page) | oauth + Meta Graph upload when a Page token exists | Page id from `/me/accounts` at connect | Not used (publish immediately after gates) | MOCK-TESTED; needs HTTPS Meta app + owner login |
| Instagram Reels | oauth, via linked Page's IG professional account | IG user id from Page | No | MOCK-TESTED; same blockers |
| TikTok | manual task (Direct Post API needs app audit; unaudited = private only) | open_id at login (profile only) | No | Manual task labelled, never shown as uploaded |
| Telegram / Discord / Mastodon / Bluesky | direct adapters (bot token / webhook / access token / app password) | Credentials validated on save; no cross-account identity API used | No (post now) | MOCK-TESTED (fake servers) |
| X, LinkedIn, Pinterest, Snapchat, Threads, Reddit | manual task (media + caption + checklist; user marks posted) | n/a | No | Manual only. Official APIs exist for some of these (paid / app review) — NOT implemented |

Rules enforced in code: manual tasks use `ManualAdapter` (`local`), never report PUBLISHED by themselves (owner presses "posted"); publish gates (`publishEnabled`, `publicVisibilityAllowed`, comments) stay false until the owner enables them; one platform/account failure never blocks other destination jobs (independent jobs, round-robin queue).
