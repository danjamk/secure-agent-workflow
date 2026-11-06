### 2026-11-05 Hold one run per issue in the delivery log

- **Decision:** A table in `DeliveryLog` holds each issue's active run. A second release while one is active is ignored. A claim older than two hours counts as stale and is replaced.
- **Why:** That object is already the strongly consistent store for releases. The two-hour limit covers a run that died without reaching teardown.
- **Rejected:** Naming the run's Durable Object by issue, which would carry one run's state into the next.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/deliveries.ts`
