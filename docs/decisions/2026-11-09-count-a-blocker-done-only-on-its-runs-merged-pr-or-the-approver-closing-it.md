### 2026-11-09 Count a blocker done only on its run's merged PR or the approver closing it

- **Decision:** A blocker is done when the PR its run opened merged into the default branch, or the approver closed it as completed. A blocker closed before the coordinator existed doesn't count until the approver reopens and closes it.
- **Why:** The agent App has `issues: write`, and another PR's `Fixes #` can close any issue, so an issue's closed state isn't evidence (design review R5, and the 2026-11-05 comment on #13).
- **Rejected:** Counting every issue closed as completed, as ADR-005 first said.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/deliveries.ts`, `orchestrator/test/coordinator.test.ts`
