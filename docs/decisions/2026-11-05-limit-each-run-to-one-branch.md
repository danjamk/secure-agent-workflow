### 2026-11-05 Limit each run to one branch

- **Decision:** The first ref a run pushes becomes its only branch, which also limits it to one PR. The approved design allowed any branch matching `agent/<issue>-*`.
- **Why:** The design review asks for writes bound to an exact branch. It also removes a race where two PRs open at once.
- **Rejected:** The approved pattern alone.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy) lists this as a deviation
