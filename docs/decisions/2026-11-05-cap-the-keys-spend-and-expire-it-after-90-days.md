### 2026-11-05 Cap the key's spend and expire it after 90 days

- **Decision:** The organization's monthly spend limit is $50 with an alert at $20. Claude recommended a 90-day expiry for the key.
- **Why:** $50 covers at least 10 runs at the $5 per-run estimate during the pilot. 90 days makes the hand rotation rare, while a key that never expires can leak unnoticed. Nothing reminds the operator before it expires.
- **Rejected:** No expiry, and 30 days.
- **Decided by:** danjamk set the limits; Claude recommended the expiry
- **Approved by:** danjamk set the spend limit. Which expiry was set isn't recorded
- **Evidence:** The Anthropic Console
