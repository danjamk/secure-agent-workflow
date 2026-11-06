### 2026-11-06 Allow three runs per release

- **Decision:** A release gets its first run and two resumes. After that, the approver adds `agent:ready` to start again.
- **Why:** This stops a loop of block, reply and block before #92 bounds spend.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `MAX_RUNS` in `orchestrator/src/run.ts`
