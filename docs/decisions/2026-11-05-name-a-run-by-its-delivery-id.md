### 2026-11-05 Name a run by its delivery id

- **Decision:** Each accepted release starts a run named by the webhook's delivery id. Relabeling an issue starts a second run.
- **Why:** It's the simplest unique name, and stopping a second run per issue is a #9 (agent CLI in a sandbox) task.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `startRun` in `orchestrator/src/webhook.ts`
