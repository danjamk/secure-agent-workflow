### 2026-11-06 Close #10 on the live test

- **Decision:** #10 (per-run logs) closes on one testbed run that printed two fake tokens: the status comment counted 4 removed, and neither reached GitHub. The stored text itself is covered by tests, since nothing serves it until #101.
- **Why:** Each task left in #10 after the split works live or is covered by tests under `test:security`.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/README.md`, Live results: run logs; agent-testbed #53 and PR #54
