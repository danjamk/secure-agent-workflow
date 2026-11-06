### 2026-11-06 Cap a run's log at 10 MB and keep it 30 days

- **Decision:** A run stores at most 10 MB of log, then a line saying it was cut. Thirty days after the run ends, its Durable Object deletes everything it holds, and keeps a flag so the same delivery can't start the run again.
- **Why:** A run's output is mostly the agent's event stream, which repeats file contents. Thirty days matches how long the delivery log keeps ids, and covers a wave's retrospective.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/run.ts`, `orchestrator/README.md` (Run logs)
