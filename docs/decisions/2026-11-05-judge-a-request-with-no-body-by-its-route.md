### 2026-11-05 Judge a request with no body by its route

- **Decision:** An empty body passes to the route rules instead of being refused as bad JSON.
- **Why:** A `DELETE` of `agent:stop` was refused as "bad body". It was still denied, but for the wrong reason, which makes a denial log misleading.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `readJson` in `orchestrator/src/outbound/handler.ts`
