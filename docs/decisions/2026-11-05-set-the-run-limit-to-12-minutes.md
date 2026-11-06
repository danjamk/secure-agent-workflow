### 2026-11-05 Set the run limit to 12 minutes

- **Decision:** A run is stopped after 12 minutes. The proposal said 10.
- **Why:** The probe's network checks each wait up to 20 to 30 seconds for a failure, and they add up close to 10 minutes on a slow instance.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `RUN_LIMIT_MS` in `orchestrator/src/run.ts`
