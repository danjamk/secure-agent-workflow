### 2026-11-06 Keep each run's log in its RunState

- **Decision:** The log is a SQLite table in the run's own `RunState` Durable Object, which already holds the run's other state.
- **Why:** Spec 0001 asks for a Durable Object per run, and `RunState` is one. A separate log object would add a binding and a migration for no gain.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/run.ts`
