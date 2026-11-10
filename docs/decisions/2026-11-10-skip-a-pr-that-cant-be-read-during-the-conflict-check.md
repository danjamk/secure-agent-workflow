### 2026-11-10 Skip a PR that can't be read during the conflict check

- **Decision:** If reading one recorded PR fails, the conflict check logs it and goes on to the others. The next check tries it again.
- **Why:** A test showed one unreadable PR stopping the check for every PR in the repo.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/coordinator.ts`, `orchestrator/test/catchup.test.ts`
