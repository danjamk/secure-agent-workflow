### 2026-11-05 Hold run tokens in memory only

- **Decision:** `RunState` keeps the installation token in memory, never in Durable Object storage. If the object is evicted, the next request mints another.
- **Why:** A token in storage outlives the run and would be one more place to leak from. Minting again is cheap.
- **Rejected:** Storing the token to avoid minting after an eviction.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), `orchestrator/src/run.ts`
