### 2026-11-05 Keep package registries in a broker setting

- **Decision:** Each repo's registries come from the `egress-hosts` broker setting. They're read-only and get no credentials.
- **Why:** A list in the repo would be one the agent can edit.
- **Rejected:** A file in each consumer repo.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), `deploy/README.md`
