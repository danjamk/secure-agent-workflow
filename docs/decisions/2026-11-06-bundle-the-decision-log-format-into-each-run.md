### 2026-11-06 Bundle the decision log format into each run

- **Decision:** The Worker writes `standards/decision-log.md` into the container next to the agent instructions, and the instructions say where it is.
- **Why:** In #11's live test, two agents wrote log entries without the format's fields. They had only the instructions, which name a file the consumer repo doesn't have.
- **Decided by:** Claude
- **Approved by:** danjamk, replied "go" to the fix list in the working session
- **Evidence:** `orchestrator/src/agents/claude-code.ts`
