### 2026-11-05 Set body limits in the outbound handler

- **Decision:** 64 KB for a push's ref commands, 1 MB for GitHub API bodies and 32 MB for model bodies. Anything larger is denied.
- **Why:** The handler buffers these to check them. The figures are my judgment and aren't measured, so #9 (agent CLI in a sandbox) may need to raise the model limit.
- **Decided by:** Claude
- **Approved by:** None. PR #81 (outbound policy) merged, but its description didn't list this
- **Evidence:** `orchestrator/src/outbound/handler.ts`
