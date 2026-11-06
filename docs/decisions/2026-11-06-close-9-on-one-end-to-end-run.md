### 2026-11-06 Close #9 on one end-to-end run

- **Decision:** #9 (agent CLI in a sandbox) closes after one end-to-end run on the testbed, with the two problems it found fixed in the same PR.
- **Why:** The run met the issue's acceptance test: a released issue became a tier 1 PR that merged on green. The fixes are small and covered by tests. The next real issue will exercise them.
- **Rejected:** A second run before closing.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/README.md`, Live results: the first agent run
