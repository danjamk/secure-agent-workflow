### 2026-11-06 Add agent:blocked when a budget blocks a run

- **Decision:** A run blocked by its own budget gets `agent:blocked`, like a run that hits its time limit.
- **Why:** In the live test the run ended blocked with no label. The finish step took the block flag to mean the agent had added the label.
- **Decided by:** Claude
- **Approved by:** danjamk, "go" to the fix list in the working session
- **Evidence:** `orchestrator/src/run.ts`, `orchestrator/test/run.test.ts`
