### 2026-11-05 Register a run's intercepts once per container

- **Decision:** A run registers its intercepts the first time it sees its container, and again only if the Durable Object restarts. It used to register them on every 10-second check.
- **Why:** In the first live probe, the call that opens the PR waited 10.3 seconds and got a 502, and GitHub accepted the same PR in 1.7 seconds when sent directly. The likeliest cause is re-registering while that request was in flight, even though Cloudflare's docs say that doesn't drop connections. The second live run tests this.
- **Rejected:** Retrying the call in the probe, which would hide the cause from an agent too.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/run.ts`, the first probe's comment on agent-testbed #34
