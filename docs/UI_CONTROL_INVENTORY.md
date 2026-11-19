# UI control inventory (generated from src/server/ui.html, 2026-11-19)

Static inventory. Classification: **ROUTE_EXISTS** = path is served by app.ts (enforced by test/ui_api_routes.test.ts). **BROWSER_TESTED** = clicked in real Chromium by test/ui_tabs.test.ts (only the 8 tab buttons + legacy hashes so far). Everything else is UNVERIFIED on a real device: a click-through of each action is still a manual check (PENDING_CHECKLIST.md).

- Tabs: Home, Sources, Clips, Studio, Queue, Accounts, Analytics, Settings (BROWSER_TESTED).
- Static `<button>` elements in markup: 322 (dynamic buttons are created in JS).
- Distinct API paths called by the UI: 64

| API path | UI references | Status |
|---|---|---|
| `/api/accounts` | 4 | ROUTE_EXISTS |
| `/api/activity` | 1 | ROUTE_EXISTS |
| `/api/ai/env` | 1 | ROUTE_EXISTS |
| `/api/ai/fix` | 1 | ROUTE_EXISTS |
| `/api/ai/models` | 1 | ROUTE_EXISTS |
| `/api/ai/provider` | 1 | ROUTE_EXISTS |
| `/api/ai/providers` | 1 | ROUTE_EXISTS |
| `/api/analytics` | 1 | ROUTE_EXISTS |
| `/api/analytics/collect` | 1 | ROUTE_EXISTS |
| `/api/analytics/import` | 1 | ROUTE_EXISTS |
| `/api/autopilot` | 6 | ROUTE_EXISTS |
| `/api/calendar` | 1 | ROUTE_EXISTS |
| `/api/channels` | 26 | ROUTE_EXISTS |
| `/api/clips` | 19 | ROUTE_EXISTS |
| `/api/comments` | 5 | ROUTE_EXISTS |
| `/api/comments/collect` | 1 | ROUTE_EXISTS |
| `/api/config` | 4 | ROUTE_EXISTS |
| `/api/connections` | 1 | ROUTE_EXISTS |
| `/api/connections/test` | 1 | ROUTE_EXISTS |
| `/api/credentials` | 1 | ROUTE_EXISTS |
| `/api/distribute` | 2 | ROUTE_EXISTS |
| `/api/distribution` | 1 | ROUTE_EXISTS |
| `/api/doctor` | 1 | ROUTE_EXISTS |
| `/api/local/report` | 1 | ROUTE_EXISTS |
| `/api/login` | 2 | ROUTE_EXISTS |
| `/api/logs` | 1 | ROUTE_EXISTS |
| `/api/manifest` | 1 | ROUTE_EXISTS |
| `/api/manual` | 1 | ROUTE_EXISTS |
| `/api/meta/accounts` | 1 | ROUTE_EXISTS |
| `/api/oauth` | 2 | ROUTE_EXISTS |
| `/api/oauth/base` | 1 | ROUTE_EXISTS |
| `/api/oauth/facebook/callback` | 2 | ROUTE_EXISTS |
| `/api/oauth/relay` | 1 | ROUTE_EXISTS |
| `/api/oauth/tiktok/callback` | 2 | ROUTE_EXISTS |
| `/api/oauth/tunnel` | 1 | ROUTE_EXISTS |
| `/api/oauth/youtube/callback` | 1 | ROUTE_EXISTS |
| `/api/platforms` | 3 | ROUTE_EXISTS |
| `/api/presets` | 3 | ROUTE_EXISTS |
| `/api/remeta` | 1 | ROUTE_EXISTS |
| `/api/run` | 2 | ROUTE_EXISTS |
| `/api/schedule` | 1 | ROUTE_EXISTS |
| `/api/settings` | 2 | ROUTE_EXISTS |
| `/api/settings/ai` | 1 | ROUTE_EXISTS |
| `/api/settings/oauth-app` | 3 | ROUTE_EXISTS |
| `/api/setup` | 1 | ROUTE_EXISTS |
| `/api/sources` | 13 | ROUTE_EXISTS |
| `/api/sources/poll` | 1 | ROUTE_EXISTS |
| `/api/status` | 1 | ROUTE_EXISTS |
| `/api/storage` | 2 | ROUTE_EXISTS |
| `/api/storage/run` | 1 | ROUTE_EXISTS |
| `/api/storage/test` | 1 | ROUTE_EXISTS |
| `/api/stream` | 1 | ROUTE_EXISTS |
| `/api/stt/local` | 2 | ROUTE_EXISTS |
| `/api/stt/local/test` | 1 | ROUTE_EXISTS |
| `/api/todo` | 1 | ROUTE_EXISTS |
| `/api/transcript` | 2 | ROUTE_EXISTS |
| `/api/transcript/edit` | 1 | ROUTE_EXISTS |
| `/api/upload` | 1 | ROUTE_EXISTS |
| `/api/uploads` | 8 | ROUTE_EXISTS |
| `/api/uploads/clear` | 1 | ROUTE_EXISTS |
| `/api/videos` | 3 | ROUTE_EXISTS |
| `/api/why` | 1 | ROUTE_EXISTS |
| `/api/youtube` | 2 | ROUTE_EXISTS |
| `/api/youtube/settings` | 2 | ROUTE_EXISTS |
