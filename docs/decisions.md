# Decisions

What was decided, why, who decided and who approved it. `standards/decision-log.md` has the rules. This is a record: it doesn't grant approval, and GitHub's history of the linked PR settles any disagreement.

The log starts on 2026-11-05 with the decisions behind #8 (outbound handlers). Earlier decisions are in `docs/adr/` and in issue and PR comments.

### 2026-11-05 Use the platform's container API, with no SDK dependency

- **Decision:** The orchestrator starts containers through `ctx.container` and handles outbound traffic in its own `Outbound` entrypoint. It doesn't depend on `@cloudflare/sandbox`.
- **Why:** Sandbox SDK 1.0 moved outbound control to the platform and removed the `allowedHosts` API that ADR-004 and #8 named. The package now adds only file helpers.
- **Rejected:** Pinning SDK 0.x to keep the API the issue named, because it's replaced.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), [#8 design comment](https://github.com/danjamk/secure-agent-workflow/issues/8#issuecomment-6657191929), ADR-004

### 2026-11-05 Split #8 into the policy and a live container proof

- **Decision:** #8 (outbound handlers) keeps the filters, credential injection, run scope and stop check, tested without a container. #79 (container proof) runs them in a real container. Model output ceilings, concurrency and the price map move to #11 (stop, blocked, resume).
- **Why:** The policy alone was more than the 1 to 2 day limit, and containers add Docker builds and a possible token change.
- **Rejected:** One large issue and PR, which would be hard to review.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), [#8 design comment](https://github.com/danjamk/secure-agent-workflow/issues/8#issuecomment-6657191929)

### 2026-11-05 Bind each run to its repo, issue and PR

- **Decision:** Each run gets its repo, issue and default branch as entrypoint props. The token is minted for the immutable repo id, and the PR's number and node ID are pinned from GitHub's response.
- **Why:** The design review (R4) asks for every write to be tied to one run. The tier check's exemption for owner-authored PRs also depends on the agent staying off other branches.
- **Rejected:** Limiting pushes to `agent/*` only, which lets one run touch another run's branch.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), [#8 design comment](https://github.com/danjamk/secure-agent-workflow/issues/8#issuecomment-6657191929)

### 2026-11-05 Block force-pushes with a ruleset

- **Decision:** A GitHub ruleset on `agent/**`, applied by bootstrap, rejects non-fast-forward updates. The push filter checks ref names and deletions.
- **Why:** A push's ref commands can't show a force-push. That takes the commit graph, and the new objects aren't on GitHub yet.
- **Rejected:** Parsing the pack in the Worker, which is more code to get wrong and duplicates what GitHub enforces.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), `bootstrap/README.md`. Live proof is in #79 (container proof)

### 2026-11-05 Allow only listed GitHub calls, and rebuild what's forwarded

- **Decision:** REST is an enumerated allowlist. GraphQL is parsed with the `graphql` package and allows reads plus one listed mutation on the run's own PR. The handler forwards a rebuilt URL, a short list of headers and JSON rebuilt from what it checked.
- **Why:** This stops the filter and GitHub reading one request differently, and it closes aliases, fragments and batching, which the design review calls out.
- **Rejected:** A hand-written GraphQL parser, and a list of denied calls, which fails open on anything new.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), `orchestrator/test/outbound/policy.test.ts`

### 2026-11-05 Keep package registries in a broker setting

- **Decision:** Each repo's registries come from the `egress-hosts` broker setting. They're read-only and get no credentials.
- **Why:** A list in the repo would be one the agent can edit.
- **Rejected:** A file in each consumer repo.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), `deploy/README.md`

### 2026-11-05 Limit each run to one branch

- **Decision:** The first ref a run pushes becomes its only branch, which also limits it to one PR. The approved design allowed any branch matching `agent/<issue>-*`.
- **Why:** The design review asks for writes bound to an exact branch. It also removes a race where two PRs open at once.
- **Rejected:** The approved pattern alone.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy) lists this as a deviation

### 2026-11-05 Block vendor-run tools and URL inputs on model calls

- **Decision:** Model calls can't use MCP servers, web search, web fetch, code execution or inputs the vendor fetches by URL.
- **Why:** Each makes the vendor contact a host on the agent's behalf, which goes around the egress allowlist. Side effect: an agent CLI's web search won't work unless #9 (agent CLI in a sandbox) opens it up.
- **Rejected:** Checking only the endpoint and model, as the issue asked.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), `orchestrator/src/outbound/models.ts`

### 2026-11-05 Refuse redirects on calls with a credential

- **Decision:** The handler never follows a redirect, and it returns a 502 for one from a call that carried a credential.
- **Why:** A `Location` can hold a signed URL, such as for a tarball, and returning it would give the sandbox a credential.
- **Rejected:** Passing redirects back to the client, which is what the handler does for registries, because those calls carry no credential.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy) notes that the test for this wasn't negative-verified

### 2026-11-05 Change the code rather than dismiss a false CodeQL alert

- **Decision:** A high-severity CodeQL alert on the registry lookup was a false positive, so the lookup became a `Set` and gained a test that pins the exact match.
- **Why:** Dismissing a high-severity alert on a security control leaves a record that's harder to trust, and this fix was small.
- **Rejected:** Dismissing the alert.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), commit 480d7b3

### 2026-11-05 Keep a decision log

- **Decision:** Each repo keeps `docs/decisions.md`, covering decisions by people and by agents, with who approved each. Agents always write `Approved by: None`. The file stays tier 1.
- **Why:** Decisions were spread across ADRs, issue comments and PR text with no record of the approver, which makes independent review slow. Tier 1 keeps a logged decision from holding up a PR that would otherwise merge on green.
- **Rejected:** Tier 2 for the log, because every agent PR with a decision would then wait for the approver. ADRs for everything, because they're too heavy for small calls.
- **Decided by:** danjamk proposed the log; Claude proposed the format and the tier
- **Approved by:** danjamk asked for it in the working session; the format and the tier are claims until danjamk merges this PR
- **Evidence:** This entry's PR, `standards/decision-log.md`
