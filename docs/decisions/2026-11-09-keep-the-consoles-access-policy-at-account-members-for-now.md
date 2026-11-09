### 2026-11-09 Keep the console's Access policy at account members for now

- **Decision:** The console's Access policy stays at **Cloudflare account members**, the option the Worker's Access tab offers, instead of a rule for the operator's email. It's tightened before anyone else joins the factory account.
- **Why:** The operator is the account's only member. The orchestrator also requires `OPERATOR_EMAIL` on every `/api` request, so another member would reach only the placeholder page.
- **Rejected:** An email rule now, which the Worker's Access tab doesn't offer and the docs don't spell out.
- **Decided by:** danjamk, after Claude explained the orchestrator's email check
- **Approved by:** danjamk, asked "Seems like that might be enough at this time?" in the working session, and Claude agreed
- **Evidence:** `console/README.md`, Setting it up
