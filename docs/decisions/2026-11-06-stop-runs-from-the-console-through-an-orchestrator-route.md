### 2026-11-06 Stop runs from the console through an orchestrator route

- **Decision:** The console stops a run by calling `POST /api/runs/<repo>/<issue>/stop` on the orchestrator, which verifies the Cloudflare Access JWT itself and runs #11's stop. ADR-010 has the checks and the alternatives.
- **Why:** The console holds no credential, and the audit trail stays in GitHub as a label event and a PR comment.
- **Rejected:** A GitHub user token in the console, which spec 0001 rules out.
- **Decided by:** Claude proposed, following spec 0002's proposal
- **Approved by:** None
- **Evidence:** ADR-010, spec 0002 (Stop)
