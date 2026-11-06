### 2026-11-06 Learn of a block from the policy, and resume on the approver's reply

- **Decision:** A run is blocked when the agent's `agent:blocked` label gets through the outbound policy, or when it hits the time limit. A reply from the approver on the issue or its PR starts a fresh run with the branch and PR pinned. Removing the label does nothing.
- **Why:** The record comes from the policy layer, not from what the agent says. Accepting a reply on the issue or the PR costs nothing, and the issue is where the status comment is.
- **Rejected:** PR comments only, as the spec first said.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/webhook.ts`, `orchestrator/test/lifecycle.test.ts`
