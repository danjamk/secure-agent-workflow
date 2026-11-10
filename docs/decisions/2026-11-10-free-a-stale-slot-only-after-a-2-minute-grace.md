### 2026-11-10 Free a stale slot only after a 2-minute grace

- **Decision:** The reconciler frees an active run's slot when the run's `RunState` has ended or was never started, but only if the slot is at least 2 minutes old. The run's areas stay until its PR is checked.
- **Why:** A slot is taken just before its run is started, so a very new slot can belong to a run that's still starting.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/reconcile.ts`
