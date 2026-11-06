### 2026-11-06 Serve logs on workers.dev with no custom domain

- **Decision:** #101 serves logs through a console Worker on its own `workers.dev` hostname, protected by Access as a whole, reading from the orchestrator over a service binding. The factory account gets no custom domain.
- **Why:** The operator would rather not add a domain. Access can protect a whole Worker on `workers.dev`, but not only part of the orchestrator, whose `/webhook` must stay reachable by GitHub.
- **Rejected:** A custom domain, as ADR-010 assumes. And Access on the orchestrator with a bypass for `/webhook`, which Cloudflare's docs don't show.
- **Decided by:** danjamk chose free options. Claude proposed the console Worker
- **Approved by:** danjamk, replied "if we can use free/simple options, lets go that way" in the working session
- **Evidence:** #101, ADR-010 (console stop route), which #101 amends
