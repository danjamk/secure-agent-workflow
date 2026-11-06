### 2026-11-05 Run the container from RunState, driven by an alarm

- **Decision:** The existing `RunState` Durable Object owns the run's container. The release returns a 202 at once, and an alarm checks the run every 10 seconds until it finishes.
- **Why:** That's one object per run, and `RunState` held no data yet. A running process doesn't keep a container alive, and GitHub gives up on a webhook after 10 seconds.
- **Rejected:** A new Durable Object class for the container, and waiting for the probe inside the webhook call.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/src/run.ts`
