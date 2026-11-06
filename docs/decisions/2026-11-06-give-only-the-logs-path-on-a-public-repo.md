### 2026-11-06 Give only the log's path on a public repo

- **Decision:** On a public repo, the log link is the path alone, `/api/runs/<run>/log` on the operator console. Only a private repo gets the full URL. The orchestrator asks GitHub once per run, and an unknown answer counts as public.
- **Why:** The console's `workers.dev` hostname shares the account's subdomain with the orchestrator's, and the factory's Worker URLs are kept out of public comments. The testbed is public.
- **Rejected:** The full link everywhere, as approved before the repo's visibility came up.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/run.ts` (`logLink`), `orchestrator/test/run.test.ts`
