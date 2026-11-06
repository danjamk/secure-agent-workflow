### 2026-11-05 Ignore a release with no repo id or default branch

- **Decision:** The webhook now requires `repository.id` and `repository.default_branch`. A payload without them is ignored with a reason, like other non-releases.
- **Why:** The run's token is minted by repo id, and the PR's base must be the default branch.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `decide` in `orchestrator/src/webhook.ts`
