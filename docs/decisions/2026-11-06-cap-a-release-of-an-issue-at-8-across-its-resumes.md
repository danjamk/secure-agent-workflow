### 2026-11-06 Cap a release of an issue at $8 across its resumes

- **Decision:** Besides $5 per run and $15 per month, a release and its resumes share an $8 budget. A new `agent:ready` starts it over. A run blocked by the issue's or the month's budget can't be resumed.
- **Why:** A resume gets a fresh run budget, so three runs could spend $15, the whole month, on one issue.
- **Rejected:** The monthly budget as the only limit across resumes.
- **Decided by:** Claude proposed, danjamk chose. Which budget blocks are resumable: Claude
- **Approved by:** danjamk, "recommendataions are good". The resumable rule: None
- **Evidence:** `orchestrator/src/deliveries.ts`, `orchestrator/wrangler.jsonc`
