### 2026-11-10 Close #110 on the live test and its fix

- **Decision:** #110 (reconcile missed webhooks) closes on one release caught with the App's webhook off, and the fix for the old-label release the same test found. The no-repeat check is covered by tests, because the issue closed before the next pass.
- **Why:** The reconciler catches a missed release live, and the bug the test exposed is fixed and tested.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/README.md`, Live results: reconciling
