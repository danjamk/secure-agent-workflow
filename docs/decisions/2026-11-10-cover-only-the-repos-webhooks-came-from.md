### 2026-11-10 Cover only the repos webhooks came from

- **Decision:** Each accepted webhook records its repo's id, name, installation and default branch, and the reconciler covers those repos.
- **Why:** The reconciler needs the installation and repo id to mint a token, and a repo that never sent a webhook has no state to reconcile.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/webhook.ts`, `orchestrator/src/deliveries.ts` (`recordRepo`)
