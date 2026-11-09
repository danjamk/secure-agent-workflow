### 2026-11-09 Read blockers in the webhook with a token revoked straight after

- **Decision:** A release mints an installation token for the repo, reads the issue's blockers from GitHub's issue dependencies, and revokes the token before queueing the issue. A release that would be refused is refused before the token is minted.
- **Why:** The snapshot has to be taken when the operator releases the issue. The token is needed for one call.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/webhook.ts` (`release`), `orchestrator/src/github.ts` (`getBlockers`)
