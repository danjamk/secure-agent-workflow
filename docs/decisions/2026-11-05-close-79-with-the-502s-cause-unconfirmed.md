### 2026-11-05 Close #79 with the 502's cause unconfirmed

- **Decision:** #79 (container proof) closes on three live runs: 40 of 42, then 42 of 42 twice. The first run's 502 on opening the PR isn't explained for certain.
- **Why:** The second run passed on the same build, so the failure comes and goes. The third, with intercepts registered once, passed too. The handler now logs upstream 5xx, so a repeat during #9 would show its source. Keeping #79 open wouldn't produce more evidence.
- **Rejected:** More probe runs to try to reproduce it.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/README.md`, Live results: the outbound probe
