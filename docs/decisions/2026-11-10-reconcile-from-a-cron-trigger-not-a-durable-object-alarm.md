### 2026-11-10 Reconcile from a cron trigger, not a Durable Object alarm

- **Decision:** The 5-minute reconciliation runs from the orchestrator Worker's cron trigger, `*/5 * * * *`, through a `scheduled()` handler.
- **Why:** It's free and needs no dashboard step. It reaches the coordinator the same way the webhook does, where an alarm inside `DeliveryLog` would have to call back into itself to start runs.
- **Rejected:** A Durable Object alarm, as ADR-005 says.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/index.ts`, `orchestrator/wrangler.jsonc`, ADR-005
