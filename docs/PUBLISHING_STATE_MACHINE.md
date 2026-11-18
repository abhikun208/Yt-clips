# Publishing state machine (src/publish/machine.ts)
READY_FOR_QC → QC_PASSED → UPLOAD_PENDING → UPLOADING → UPLOAD_VERIFYING → UNLISTED_VERIFIED → SCHEDULED_OR_APPROVED → PUBLISHED → ANALYTICS_WAIT → ANALYZING → LEARNING → NEXT_CYCLE. Failure states: QC_FAILED, FAILED. Invalid transitions are rejected by `advance()`.
- Pause (not failure) reasons keep the same step: NETWORK_ERROR, PUBLISH_DISABLED, PUBLIC_DISABLED, NEEDS_APPROVAL, NOT_READY, QUOTA_EXCEEDED, AUTH_* (incl. AUTH_IDENTITY_MISMATCH), WAIT_SCHEDULE, WAIT_PUBLIC_DELAY, MANUAL_POST_REQUIRED, UNLISTED_BUFFER, HELD_RESTRICTED, SANDBOX_HOLD, DESTINATION_DISABLED.
- Upload is resumable (`upload_sessions` stores session URI + remote id; restart continues, never restarts from zero).
- PUBLISHED only after API re-read confirms visibility (else NOT_READY). Independent switches: autoQueue, auto-approve, unlistedFirst, autoPublic + delay, gates.publishEnabled / publicEnabled. `--auto-public` never overrides the public gate.
- Verification: remote title/visibility/processing checked (`verify`); title compared as YouTube stores it.
