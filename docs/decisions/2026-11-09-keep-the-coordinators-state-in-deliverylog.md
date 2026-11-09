### 2026-11-09 Keep the coordinator's state in DeliveryLog

- **Decision:** The queue, generations, area locks, PR records and completion records are tables in `DeliveryLog`, the one global Durable Object, not a new coordinator object.
- **Why:** `DeliveryLog` already holds the active runs, which are the slots, and the blocked runs and spend ledger. Two objects would have to agree on the same slots.
- **Rejected:** A separate coordinator Durable Object, as ADR-005 first described it.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/deliveries.ts`, ADR-005 (revised)
