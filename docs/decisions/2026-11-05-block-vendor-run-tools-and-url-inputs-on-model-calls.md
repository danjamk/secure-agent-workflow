### 2026-11-05 Block vendor-run tools and URL inputs on model calls

- **Decision:** Model calls can't use MCP servers, web search, web fetch, code execution or inputs the vendor fetches by URL.
- **Why:** Each makes the vendor contact a host on the agent's behalf, which goes around the egress allowlist. Side effect: an agent CLI's web search won't work unless #9 (agent CLI in a sandbox) opens it up.
- **Rejected:** Checking only the endpoint and model, as the issue asked.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), `orchestrator/src/outbound/models.ts`
