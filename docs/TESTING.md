# Testing
`npm test` (node:test, zero dependencies, ~460 tests, 15-20 min on the sandbox). All external APIs are fakes (`test/fakeGoogle.ts`, ad-hoc http servers); CI never publishes anything. Real-account checks are manual and listed in PENDING_CHECKLIST.md.
Key suites: webauth, destinations, accounts_http (browser-exact URLs), channelclient, multichannel_upload, identity_guard, source_mapping, verifyrecover, autopublic, modelheal, quality2k (real ffmpeg + ffprobe), renderrobust, editormeta.
Known flaky under heavy load: hardening.test.ts multi-process queue (passes alone).
