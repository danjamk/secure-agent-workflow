### 2026-11-10 Forget a run's PR once it closes

- **Decision:** When a recorded PR closes, its record and its catch-up count are deleted.
- **Why:** The conflict check reads every recorded PR, so closed ones would cost a call each pass. A closed PR needs no catch-up, and its completion was already recorded when it closed.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/deliveries.ts` (`pullRequestClosed`)
