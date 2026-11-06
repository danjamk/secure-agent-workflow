### 2026-11-06 Keep the reservation when a call's billing is unknown

- **Decision:** A stream cut off before `message_stop`, a body with no usage, or a send that fails keeps the whole reservation. An error response settles to $0.
- **Why:** R3 says to keep a conservative charge for a request with ambiguous billing rather than refund it. Error responses aren't billed.
- **Decided by:** Claude
- **Approved by:** danjamk, "recommendataions are good"
- **Evidence:** `orchestrator/src/outbound/handler.ts`, `orchestrator/test/outbound/spend.test.ts`
