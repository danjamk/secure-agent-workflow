### 2026-11-05 Change the code rather than dismiss a false CodeQL alert

- **Decision:** A high-severity CodeQL alert on the registry lookup was a false positive, so the lookup became a `Set` and gained a test that pins the exact match.
- **Why:** Dismissing a high-severity alert on a security control leaves a record that's harder to trust, and this fix was small.
- **Rejected:** Dismissing the alert.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), commit 480d7b3
