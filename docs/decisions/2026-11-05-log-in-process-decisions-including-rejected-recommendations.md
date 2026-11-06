### 2026-11-05 Log in-process decisions, including rejected recommendations

- **Decision:** The log now covers any choice someone might later wonder about, including small ones an agent makes along the way. `Approved by: None` is a normal value. A rejected recommendation gets its own entry, whoever rejects it. Logging doesn't change what agents may decide alone. This replaces the stricter test in "Keep a decision log".
- **Why:** The first test would have left out the small calls people want to look back on, and agent collaboration or evaluation could add agents that turn down recommendations.
- **Rejected:** Adding a field for rejections, because an entry that names what was rejected already covers it.
- **Decided by:** danjamk asked for the wider scope; Claude chose the wording and the rejection format
- **Approved by:** danjamk asked for the scope in the working session; the wording and format are claims until danjamk merges this PR
- **Evidence:** This entry's PR, `standards/decision-log.md`
