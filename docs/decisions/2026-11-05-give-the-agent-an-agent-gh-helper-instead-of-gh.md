### 2026-11-05 Give the agent an agent-gh helper instead of gh

- **Decision:** The image has an `agent-gh` command for the agent's GitHub writes, made as plain REST and GraphQL calls, and no `gh` CLI.
- **Why:** `gh` makes PR and comment writes through GraphQL mutations the policy refuses. The helper uses only calls the policy allows.
- **Rejected:** Opening those `gh` mutations in the policy.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/container/agent-gh`
