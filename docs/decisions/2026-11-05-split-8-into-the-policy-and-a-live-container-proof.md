### 2026-11-05 Split #8 into the policy and a live container proof

- **Decision:** #8 (outbound handlers) keeps the filters, credential injection, run scope and stop check, tested without a container. #79 (container proof) runs them in a real container. Model output ceilings, concurrency and the price map move to #11 (stop, blocked, resume).
- **Why:** The policy alone was more than the 1 to 2 day limit, and containers add Docker builds and a possible token change.
- **Rejected:** One large issue and PR, which would be hard to review.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), [#8 design comment](https://github.com/danjamk/secure-agent-workflow/issues/8#issuecomment-6657191929)
