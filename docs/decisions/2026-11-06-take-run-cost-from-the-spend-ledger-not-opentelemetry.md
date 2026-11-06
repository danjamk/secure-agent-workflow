### 2026-11-06 Take run cost from the spend ledger, not OpenTelemetry

- **Decision:** #10's cost and token task is met by #92's ledger, which the status comment already reports. The agent CLI's OpenTelemetry output isn't read.
- **Why:** The outbound handler sees every model call and its usage. The CLI's figures are its own estimate.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** #92 (meter model spend), comment on #10
