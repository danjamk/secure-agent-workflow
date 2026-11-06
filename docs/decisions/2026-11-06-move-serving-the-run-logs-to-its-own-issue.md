### 2026-11-06 Move serving the run logs to its own issue

- **Decision:** #10 (per-run logs) captures, redacts, stores and keeps each run's log. Serving it behind Cloudflare Access, and linking it from the PR, moves to #101.
- **Why:** Serving needs a hostname, an Access application and a JWT check, which together would push #10 past two days. The console needs the same pieces.
- **Rejected:** Doing both in #10.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "go ahead and split" in the working session
- **Evidence:** #10, #101 (serve run logs behind Cloudflare Access on workers.dev)
