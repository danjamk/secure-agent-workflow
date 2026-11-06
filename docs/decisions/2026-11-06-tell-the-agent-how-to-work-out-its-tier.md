### 2026-11-06 Tell the agent how to work out its tier

- **Decision:** The agent instructions say to take the tier from the repo's `standards/tier-map.yml`: the highest tier of any changed path, with an unmatched path at tier 2.
- **Why:** An agent called a PR that adds `LICENSE` tier 1. The gate overruled it, but the tier line is what the approver reads first.
- **Decided by:** Claude
- **Approved by:** danjamk, replied "go" to the fix list in the working session
- **Evidence:** `standards/agent-instructions.md`, agent-testbed PR #43
