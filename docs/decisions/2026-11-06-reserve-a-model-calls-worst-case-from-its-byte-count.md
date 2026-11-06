### 2026-11-06 Reserve a model call's worst case from its byte count

- **Decision:** Before a charged call, the outbound handler reserves the body's bytes at the dearest input rate plus `max_tokens` at the output rate, and refuses the call if the run, the issue or the month can't cover it.
- **Why:** A token is at least a byte, so the bound can't come in low, and it needs no extra call. R3 asks for spend to be bounded before a call, not observed after.
- **Rejected:** A `count_tokens` call before each request. It's exact, but adds a round trip per call and another request shape to keep in step with the messages endpoint.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, "recommendataions are good"
- **Evidence:** `orchestrator/src/outbound/spend.ts`, `orchestrator/README.md` (Model spend)
