# OAuth & account architecture (as implemented)
Status legend: VERIFIED = covered by an automated test against fake servers (no real Google/Meta/TikTok in CI); UNVERIFIED = needs the owner's real accounts.

| Concept | Where | Notes |
|---|---|---|
| OAuth application credentials | global `youtube-client` secret / env; per-channel override `<token>-client` | Per-channel client lets a channel of another Google project log in with its own client (VERIFIED: channelclient.test.ts) |
| Grants / tokens | AES-256-GCM `SecretStore` (`youtube`, `youtube-<slug>`, `facebook`, …) | A YouTube token stores the client that minted it and always refreshes with that client (VERIFIED) |
| Connected account identity | `ytinfo:<slug>` kv (channelId, title) from `channels.list?mine=true` | Never shown as connected without a verified identity |
| Publishing destination | `destinations` table (`yt:<channelId>`, `fb:<pageId>`, `ig:<igId>`, `tt:<openId>`) | Pointer to secret only; status derived from evidence; `enabled` flag |
| Job → destination | `uploads.destination_id` stamped at advance; `channel_id` immutable per job | Disabled/disconnected destination blocks only its own jobs (`DESTINATION_DISABLED`) |
| Source → destination | `sources.channel_id` (default) + `source_destinations` extra mappings (API `/api/sources/<id>/destinations`) | One source can feed several channels, one job per destination (VERIFIED: source_mapping.test.ts). No UI yet |

Identity guard: before every YouTube upload the login is asked who it is (`channels.list mine=true`); if it differs from the channel registered for the clip, upload is paused with `AUTH_IDENTITY_MISMATCH` (VERIFIED: identity_guard.test.ts).
Duplicate channel: same external channel id under two slugs is flagged; "Duplicate hatao" keeps one (VERIFIED: accounts_http.test.ts). Disconnect removes tokens from every slug of that account and tries Google revocation (revoke result reported honestly).
Callbacks: YouTube uses the server's own `/auth/...` route on http://127.0.0.1 (Google allows loopback). Meta/TikTok need HTTPS: `docs/oauth-relay.html` on GitHub Pages is ONLY a redirect page back to the phone's loopback, NOT a proxy. A real HTTPS callback needs an owner-provided domain or tunnel (UNVERIFIED, owner action).
