### 2026-11-05 Drop the test for retrying a failed release

- **Decision:** The webhook test that forced a token failure and redelivered is removed. The webhook no longer mints, so that failure can't happen there. The code that forgets a delivery when starting a run fails is still there, but no test covers it.
- **Why:** I didn't find a way to make the Durable Object call fail in the test pool without a test-only hook in the Worker.
- **Rejected:** Adding a test-only setting to the Worker.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/test/webhook.test.ts`
