### 2026-11-06 Link each run's log from its status comment and its PR

- **Decision:** With `CONSOLE_URL` set, the status comment links the log when the run starts and when it ends, and the run's PR gets one comment with the link when the run ends.
- **Why:** Spec 0001 wants the log one click from the run's PR. A link at the start lets the operator read a run while it's going.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/run.ts`, `orchestrator/test/run.test.ts`
