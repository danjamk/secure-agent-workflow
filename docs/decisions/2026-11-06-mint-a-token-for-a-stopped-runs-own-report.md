### 2026-11-06 Mint a token for a stopped run's own report

- **Decision:** A stopped run's token is revoked at once. To edit its status comment and comment on the PR, the Worker mints a separate token and revokes it right after.
- **Why:** The run's own token is refused once the stop flag is set, which is what blocks the container. The report token never reaches the container, which is already destroyed.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `reportingToken` in `orchestrator/src/run.ts`
