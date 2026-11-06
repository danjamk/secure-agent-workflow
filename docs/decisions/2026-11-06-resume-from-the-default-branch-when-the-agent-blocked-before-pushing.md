### 2026-11-06 Resume from the default branch when the agent blocked before pushing

- **Decision:** A run that ends blocked saves a resume point even without a branch. Its resume starts from the default branch, with the reply.
- **Why:** The status comment offered a resume either way, and with no branch saved, a reply did nothing.
- **Decided by:** Claude
- **Approved by:** danjamk, replied "go" to the fix list in the working session
- **Evidence:** `orchestrator/src/run.ts`, `orchestrator/test/lifecycle.test.ts`
