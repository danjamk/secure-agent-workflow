### 2026-11-06 Close #92 on the live tests

- **Decision:** #92 (meter model spend) closes on one metered run, one blocked run and the fixes in the same PR. The per-run match against the Anthropic console isn't verified, because the console reports by day.
- **Why:** Each task in the issue works live or is covered by tests under `test:security`.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/README.md`, Live results: model spend
