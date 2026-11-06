### 2026-11-06 Check the month's budget when the run starts, not at the webhook

- **Decision:** A run whose month has less than a run's budget left ends before its container starts, and says so in its status comment.
- **Why:** The run already posts and edits the status comment. Refusing at the webhook would leave the approver with only a line in the App's delivery log.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/run.ts`, `orchestrator/test/run.test.ts`
