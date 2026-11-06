### 2026-11-05 Use an API key, not Anthropic's identity federation

- **Decision:** The Worker uses a static Anthropic API key.
- **Why:** Identity federation takes tokens from GCP, AWS, Azure or GitHub Actions, and a Cloudflare Worker has none of those. Signing our own tokens would make the signing key the static secret instead. Revisit if Cloudflare gains workload identity or Anthropic accepts other issuers.
- **Rejected:** Identity federation.
- **Decided by:** Claude
- **Approved by:** danjamk, by creating the key
- **Evidence:** The Anthropic Console's key dialog, 2026-11-05
