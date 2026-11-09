### 2026-11-09 Trust a closed PR event from anyone, for the run's own PR

- **Decision:** `pull_request.closed` is acted on whoever sent it, but only for a PR the coordinator recorded when a run pinned it, and a merge counts only if GitHub says it merged into the default branch.
- **Why:** Merges come from auto-merge and from the approver, and what matters is GitHub's record that it merged, which the gate controls. A PR no run opened changes nothing.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/webhook.ts` (`decidePullRequest`), `orchestrator/test/coordinator.test.ts`
