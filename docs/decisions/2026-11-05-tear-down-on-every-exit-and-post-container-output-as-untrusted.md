### 2026-11-05 Tear down on every exit, and post container output as untrusted

- **Decision:** Every way a run ends goes through one step that destroys the container, posts the result and stops the run. The posted output has credentials scrubbed, a length cap and no way to close its code block.
- **Why:** `exec` has no timeout of its own, and the output comes from code the orchestrator doesn't trust.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/test/run.test.ts`
