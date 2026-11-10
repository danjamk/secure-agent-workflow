### 2026-11-10 Check for conflicts after merges and on each reconciler pass, not on push events

- **Decision:** The coordinator checks the open PRs runs opened for conflicts 20 seconds after any PR merges into the default branch, and on every 5-minute reconciler pass. The App isn't subscribed to `push` events.
- **Why:** A merge is when another PR starts to conflict, and the coordinator already gets `pull_request.closed`. The reconciler catches merges the webhook missed. No change to the App's events is needed.
- **Rejected:** Subscribing the App to `push`, which ADR-005 named, and which needs a change in the App's settings.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/webhook.ts` (`checkCatchUps`), `orchestrator/src/reconcile.ts`, ADR-005
