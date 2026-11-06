### 2026-11-06 Console defaults: refresh, feed lost, caution, spend day

- **Decision:** The console refreshes every 15 seconds, shows feed lost after 30 seconds without a successful fetch, shows spend caution at 80% of the daily limit, and treats the spend day as the UTC day.
- **Why:** The design gives no numbers for the first three. The UTC day matches the coordinator, which totals and resets spend per UTC day (ADR-005).
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `docs/plans/console-phase-1.md`, W1-2 and W1-5
