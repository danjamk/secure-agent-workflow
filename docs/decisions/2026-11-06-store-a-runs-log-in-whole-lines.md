### 2026-11-06 Store a run's log in whole lines

- **Decision:** Each check stores the new output only up to its last newline. A line over 256KB is split at a space, quote or comma. The last line is taken when the run ends.
- **Why:** A credential split across two reads would slip past both redactions. Those three bytes can't appear inside a token or key.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/run.ts` (`takeLines`), `orchestrator/test/redact.test.ts`
