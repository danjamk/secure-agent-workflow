### 2026-11-10 Act on a missed release only from the label's event and the last release time

- **Decision:** The reconciler queues an issue only if its most recent `agent:ready` event was added by the approver, from a user account, after the issue's last handled release. Every release the webhook handles is recorded with its time, including ones refused because the issue was queued or running.
- **Why:** The label stays on an issue after a run ends blocked or failed, and the App can add labels, so the label's presence isn't evidence (design review R5). Without the refused releases, re-adding the label while a run was active would start a second run later.
- **Decided by:** Claude proposed the event check, danjamk chose. Recording refused releases: Claude, after a test showed the gap
- **Approved by:** danjamk, replied "approved" in the working session. Recording refused releases: None
- **Evidence:** `orchestrator/src/reconcile.ts`, `orchestrator/test/reconcile.test.ts`
