### 2026-11-05 Keep the model key as a Worker secret, set by hand

- **Decision:** `ANTHROPIC_API_KEY` is a secret on the Worker, set in the Cloudflare dashboard. It isn't in the AWS broker, and the CI deploy never holds it.
- **Why:** It's a runtime secret, like the App key, and those stay out of the deploy job. The container never gets it: the outbound handler adds it.
- **Rejected:** The broker, which would put the key in the deploy job's environment. A `wrangler secret put` command, which needs a one-day Cloudflare token for a step the dashboard does directly.
- **Decided by:** Claude proposed a hand step; danjamk chose the dashboard
- **Approved by:** danjamk, set the secret in the dashboard
- **Evidence:** `orchestrator/README.md`, Credentials
