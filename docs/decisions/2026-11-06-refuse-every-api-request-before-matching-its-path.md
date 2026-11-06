### 2026-11-06 Refuse every /api request before matching its path

- **Decision:** The orchestrator checks the Access JWT before routing `/api/*`, and answers every failure with the same 403 and no reason.
- **Why:** An unauthenticated caller then can't tell which routes exist or why it was refused. The reason goes to the Worker's log.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/api.ts`, `orchestrator/test/access.test.ts`
