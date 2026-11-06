### 2026-11-06 Redeploy the orchestrator when its bundled standards change

- **Decision:** `orchestrator-deploy.yml` also runs when `standards/agent-instructions.md` or `standards/decision-log.md` changes on `main`.
- **Why:** Both are bundled into the Worker and written into each run's container. A change to either alone wouldn't have reached agents until the next orchestrator change.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `.github/workflows/orchestrator-deploy.yml`
