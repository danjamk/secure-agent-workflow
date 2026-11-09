### 2026-11-09 Wait up to 15 minutes for the orchestrator's rollout

- **Decision:** `orchestrator/deploy.sh` waits up to 15 minutes for `/health` to report the new build, checking every 15 seconds, and the deploy job's timeout goes from 15 to 25 minutes.
- **Why:** The orchestrator runs containers, and Cloudflare moved traffic to its new version over about 7 minutes. The 30-second check failed a deploy that worked.
- **Decided by:** Claude
- **Approved by:** danjamk, replied "go" in the working session
- **Evidence:** `orchestrator/deploy.sh`, `.github/workflows/orchestrator-deploy.yml`, `console/README.md` (Live results)
