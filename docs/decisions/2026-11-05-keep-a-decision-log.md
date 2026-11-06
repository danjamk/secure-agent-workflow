### 2026-11-05 Keep a decision log

- **Decision:** Each repo keeps `docs/decisions.md`, covering decisions by people and by agents, with who approved each. Agents always write `Approved by: None`. The file stays tier 1.
- **Why:** Decisions were spread across ADRs, issue comments and PR text with no record of the approver, which makes independent review slow. Tier 1 keeps a logged decision from holding up a PR that would otherwise merge on green.
- **Rejected:** Tier 2 for the log, because every agent PR with a decision would then wait for the approver. ADRs for everything, because they're too heavy for small calls.
- **Decided by:** danjamk proposed the log; Claude proposed the format and the tier
- **Approved by:** danjamk asked for it in the working session; the format and the tier are claims until danjamk merges this PR
- **Evidence:** This entry's PR, `standards/decision-log.md`
