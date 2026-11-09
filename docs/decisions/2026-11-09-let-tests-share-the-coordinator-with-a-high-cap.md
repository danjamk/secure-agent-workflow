### 2026-11-09 Let tests share the coordinator with a high cap

- **Decision:** The test settings set `MAX_CONCURRENT_RUNS` to 100. The cap's own tests pass a cap to the queue directly, on a coordinator of their own.
- **Why:** The tests share one global coordinator, so a cap of 1 would make each test's release wait on runs left over from earlier tests.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/vitest.config.ts`, `orchestrator/test/coordinator.test.ts`
