### 2026-11-05 Keep running the probe after a failed clone

- **Decision:** If the clone fails, the probe records one failure for the push checks and carries on with the API and credential checks.
- **Why:** The first local run stopped at the failed clone, so the rest of the checks never ran.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/container/probe.sh`
