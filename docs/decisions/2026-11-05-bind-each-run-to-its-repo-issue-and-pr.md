### 2026-11-05 Bind each run to its repo, issue and PR

- **Decision:** Each run gets its repo, issue and default branch as entrypoint props. The token is minted for the immutable repo id, and the PR's number and node ID are pinned from GitHub's response.
- **Why:** The design review (R4) asks for every write to be tied to one run. The tier check's exemption for owner-authored PRs also depends on the agent staying off other branches.
- **Rejected:** Limiting pushes to `agent/*` only, which lets one run touch another run's branch.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), [#8 design comment](https://github.com/danjamk/secure-agent-workflow/issues/8#issuecomment-6657191929)
