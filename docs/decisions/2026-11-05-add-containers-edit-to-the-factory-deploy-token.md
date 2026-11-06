### 2026-11-05 Add Containers Edit to the factory deploy token

- **Decision:** `saw-factory-cloudflare-deploy-token` gets the account permission Containers Edit, besides Workers Scripts Edit and Account Settings Read.
- **Why:** The first deploy with the container failed at `GET /accounts/<account>/containers/me` with no reason given. The same deploy passed once the permission was added. The live Worker didn't change while it failed.
- **Rejected:** A broader token, such as the "Edit Cloudflare Workers" template.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, by adding the permission in the dashboard
- **Evidence:** Failed `orchestrator-deploy` run 42126043401, then the rerun that passed
