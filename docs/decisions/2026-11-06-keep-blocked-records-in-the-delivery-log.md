### 2026-11-06 Keep blocked records in the delivery log

- **Decision:** A blocked issue's scope, branch, PR and run number are a row in `DeliveryLog`. A reply takes the row, so two replies resume once. A new release clears it.
- **Why:** That object already holds which run is active on each issue, and taking the row there keeps a resume to one.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/deliveries.ts`
