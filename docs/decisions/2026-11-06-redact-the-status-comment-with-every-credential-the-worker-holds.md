### 2026-11-06 Redact the status comment with every credential the Worker holds

- **Decision:** The output posted in the status comment goes through the log's redaction, with every credential the Worker holds. Before, it removed only the run's own token by value, plus patterns.
- **Why:** A model key or the webhook secret printed by the agent would have reached a public comment if no pattern matched it.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/sandbox.ts`, `orchestrator/src/redact.ts`
