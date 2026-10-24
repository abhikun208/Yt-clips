# YouTube API: audit, quota and what this tool can really do

**Verified (Google quota page, fetched 2026-10-22):** `videos.insert` has its own default cap of **100 inserts/day**, and all other
calls share **10,000 units/day**. The tool tracks both (`quota_usage` table) and stops with `QUOTA_EXCEEDED` instead of failing mid-upload.

**Reported, NOT verified by the author:** videos uploaded through `videos.insert` by an API project that has not passed
Google's *API Services audit* may be forced to **private** (revision-history note, July 2020). If that applies to your project,
automatic "public" will not work until the audit passes — the tool then still stages and verifies the upload as unlisted/private
and you press publish in YouTube Studio. Check this yourself on your own project with `npm run cli -- smoke --upload short.mp4`
(uploads ONE private video; delete it afterwards).

Practical path for one owner uploading to their own channels:
1. Create a Google Cloud project, enable *YouTube Data API v3*, create an OAuth client ("TVs and limited input devices").
2. Put `YT_OAUTH_CLIENT_ID` / `YT_OAUTH_CLIENT_SECRET` in the environment; connect each channel from **Schedule → Connect** (one Google login per channel).
3. Keep `gates.publishEnabled` false until `smoke` passes; apply for the audit if uploads come back locked.
4. Repetitive/mass-produced uploads can hurt monetisation regardless of API status: clip your OWN streams, keep per-day caps low.
