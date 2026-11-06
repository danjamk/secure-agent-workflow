### 2026-11-06 Stop writes the flag first, and is final

- **Decision:** Adding `agent:stop` or removing `agent:ready` writes the run's stop flag before anything else, then revokes the token, destroys the container and reports. Removing the label afterward restarts nothing, and a stop clears a blocked issue.
- **Why:** Writing the flag first means the outbound policy refuses every request after it. The delay is the time the webhook takes, usually under a second. In-flight requests can finish, and their charges stand.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `halt` in `orchestrator/src/run.ts`, `orchestrator/test/lifecycle.test.ts`
