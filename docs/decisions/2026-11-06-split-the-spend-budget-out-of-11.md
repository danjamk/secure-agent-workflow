### 2026-11-06 Split the spend budget out of #11

- **Decision:** #11 (stop, blocked, resume) keeps the run lifecycle. The token budget, price map, output ceiling and spend ledger moved to #92 (meter model spend).
- **Why:** The design review's R3 asks for reserving cost before each call and a ledger, which is its own one to two days in the outbound handler. Until #92 lands, the workspace spend limit and Claude Code's own estimate cap spend.
- **Rejected:** One PR for both.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** [#11 design comment](https://github.com/danjamk/secure-agent-workflow/issues/11#issuecomment-6674467454), #92
