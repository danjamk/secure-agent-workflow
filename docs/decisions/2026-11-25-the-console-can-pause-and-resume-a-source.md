### 2026-11-25 The console can pause and resume a source

- **Decision:** The console gains Pause and Resume per source (nothing new starts, running work finishes), and combined feeds that show several sources side by side. ADR-013 has the details.
- **Why:** The common intervention on a local host is pausing a whole source, usually from a phone, and a hand-set pause records no reason or identity.
- **Rejected:** Pausing by stopping every running run, which throws away work in progress.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** None
- **Evidence:** ADR-013, `docs/plans/console-phase-1.md` (route contract, W1-9), spec 0002 (hard constraints 1 to 3)
