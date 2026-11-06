### 2026-11-06 File one-file-per-decision as its own issue

- **Decision:** The conflicts between agents' decision log entries go to #94, which moves the log to one file per decision.
- **Why:** It changes the standard and every consumer repo, so it needs its own review. #11's live test showed the conflict blocking an agent PR.
- **Rejected:** Leaving it to #13's catch-up runs, which would resolve conflicts after the fact, with a run each time.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "go" in the working session
- **Evidence:** #94
