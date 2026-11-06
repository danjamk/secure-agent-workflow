### 2026-11-05 Allow only listed GitHub calls, and rebuild what's forwarded

- **Decision:** REST is an enumerated allowlist. GraphQL is parsed with the `graphql` package and allows reads plus one listed mutation on the run's own PR. The handler forwards a rebuilt URL, a short list of headers and JSON rebuilt from what it checked.
- **Why:** This stops the filter and GitHub reading one request differently, and it closes aliases, fragments and batching, which the design review calls out.
- **Rejected:** A hand-written GraphQL parser, and a list of denied calls, which fails open on anything new.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), `orchestrator/test/outbound/policy.test.ts`
