### 2026-11-06 Put the console on workers.dev and keep the JWT check in the orchestrator

- **Decision:** ADR-010 is revised: the console Worker runs on its own `workers.dev` hostname behind Worker-level Access, and forwards `/api/*` to the orchestrator over a service binding. The orchestrator still verifies the Access JWT on every `/api/*` request, so the binding only carries requests.
- **Why:** The factory account has no custom domain. ADR-010 rejected a binding the orchestrator trusts, because agents write the console's code. Verifying the JWT in the orchestrator keeps that property.
- **Rejected:** A custom domain with a Workers route, as ADR-010 first had. And Access on the orchestrator with a `/webhook` bypass, which Cloudflare's docs don't show.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** ADR-010 (console stop route), #101, #105
