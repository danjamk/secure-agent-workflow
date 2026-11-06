### 2026-11-06 Skip the health check after a console deploy

- **Decision:** `console/deploy.sh` doesn't check `/health` after deploying. wrangler's result says whether the deploy worked.
- **Why:** Access covers the whole console Worker, so an unauthenticated check gets the sign-in page. A service token to get past it would be a new credential.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `console/deploy.sh`
