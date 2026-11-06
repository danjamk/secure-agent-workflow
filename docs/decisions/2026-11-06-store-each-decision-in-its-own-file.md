### 2026-11-06 Store each decision in its own file

- **Decision:** The decision log moves from `docs/decisions.md` to `docs/decisions/`, one file per decision named `YYYY-MM-DD-<slug>.md`, in the same entry format. `make decisions` prints them all in date order when someone wants to read through. No combined file is committed.
- **Why:** Two open PRs that both added entries always conflicted, which blocked an agent PR in #11's live test and three planning PRs here. New files never conflict.
- **Rejected:** A committed index generated from the files, with a check that it's current. Every PR that adds a decision would regenerate it, so PRs would conflict on it the same way.
- **Decided by:** danjamk, from a recommendation made in another working session. Claude assessed it and agreed
- **Approved by:** danjamk, replied "if so, lets do that now" in the working session
- **Evidence:** #94 (one file per decision), `standards/decision-log.md`, `docs/decisions/README.md`
