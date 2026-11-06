### 2026-11-06 Let the broker action read a setting as optional

- **Decision:** A parameter name ending in `?` is optional in the broker action: if it doesn't exist, its variable stays unset. Any other read failure still fails the step. The orchestrator's deploy reads `access-team`, `access-aud`, `operator-email` and `console-url` this way.
- **Why:** Those values don't exist until the operator sets up Access, and a required parameter that's missing fails every deploy.
- **Rejected:** Splitting #105 into two PRs, with the operator's setup between them.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `deploy/broker/aws/read-params.sh`, `.github/workflows/orchestrator-deploy.yml`
