### 2026-11-10 Ignore labels from before the coordinator heard from the repo

- **Decision:** The reconciler acts on an `agent:ready` event only if it's newer than both the issue's last handled release and the time the coordinator first heard from the repo. Repos recorded before this rule count from when it was deployed.
- **Why:** On its first pass, the reconciler released testbed #34, whose label was added on 2026-11-05, before the coordinator recorded releases. On a consumer's first deploy, every open issue still carrying an old label would have started.
- **Rejected:** A fixed age limit on labels, which would still release recent pre-deploy labels and would drop a missed webhook older than the limit.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/reconcile.ts`, `orchestrator/src/deliveries.ts` (`first_seen`), `orchestrator/README.md` (Live results: reconciling), agent-testbed #34
