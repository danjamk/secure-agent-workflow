### 2026-11-24 The console reads from the orchestrator or from files on a local host

- **Decision:** One console frontend reads either the orchestrator's `/api/*` routes or static snapshot files a local host's dispatcher writes, served over the operator's tailnet. A stdio MCP server reads the same routes. ADR-012 has the details.
- **Why:** A local host can then show the same screens without a factory-account credential on a machine where agents run.
- **Rejected:** Pushing local state to a Worker and KV in the factory account.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** None
- **Evidence:** ADR-012, `docs/plans/console-phase-1.md` (revised 2026-11-24)
