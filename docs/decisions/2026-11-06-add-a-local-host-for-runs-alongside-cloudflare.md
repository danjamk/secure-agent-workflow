### 2026-11-06 Add a local host for runs alongside Cloudflare

- **Decision:** A run executes on a `cloudflare` or a `local` host, chosen per repo in a broker setting. Both share the outbound policy modules. ADR-011 has the per-host design and the alternatives.
- **Why:** Lower token cost on a dedicated machine, and proof that the controls don't depend on Cloudflare (spec 0001, goal 6).
- **Rejected:** Docker Sandboxes, whose own TLS-terminating proxy would need forking to apply this repo's policy.
- **Decided by:** danjamk
- **Approved by:** None
- **Evidence:** ADR-011
