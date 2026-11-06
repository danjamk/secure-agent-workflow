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

### 2026-11-05 Pin `graphql` to 16.14.2

- **Decision:** The orchestrator uses `graphql` 16.14.2.
- **Why:** 16.15.0 and 17.1.0 came out the day before and fail the two-week rule. Only the parser is used, and the 16 line is the older one.
- **Rejected:** 17.0.2, which also passes the two-week rule but is a newer major version with no benefit here.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy)

### 2026-11-05 Hold run tokens in memory only

- **Decision:** `RunState` keeps the installation token in memory, never in Durable Object storage. If the object is evicted, the next request mints another.
- **Why:** A token in storage outlives the run and would be one more place to leak from. Minting again is cheap.
- **Rejected:** Storing the token to avoid minting after an eviction.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), `orchestrator/src/run.ts`

### 2026-11-05 List the headers that leave the sandbox

- **Decision:** The handler forwards only listed request headers. It drops `Accept-Encoding` and leaves compression to the Workers runtime.
- **Why:** A list keeps out `Authorization`, `Cookie`, `Proxy-*` and `X-HTTP-Method-Override` without naming each one. Dropping `Accept-Encoding` avoids decoding a response twice, which is inference from the runtime's behavior and hasn't been tested live.
- **Rejected:** Removing a list of known bad headers, which misses any header not on it.
- **Decided by:** Claude
- **Approved by:** None. PR #81 (outbound policy) merged, but its description didn't list this
- **Evidence:** `orchestrator/src/outbound/handler.ts`

### 2026-11-05 Set body limits in the outbound handler

- **Decision:** 64 KB for a push's ref commands, 1 MB for GitHub API bodies and 32 MB for model bodies. Anything larger is denied.
- **Why:** The handler buffers these to check them. The figures are my judgment and aren't measured, so #9 (agent CLI in a sandbox) may need to raise the model limit.
- **Decided by:** Claude
- **Approved by:** None. PR #81 (outbound policy) merged, but its description didn't list this
- **Evidence:** `orchestrator/src/outbound/handler.ts`

### 2026-11-05 Report two controls as not verified after a blocked check

- **Decision:** The permission system blocked temporary edits that would have removed the redirect refusal and the branch deletion check. I reported both as not negative-verified and didn't retry another way.
- **Why:** The block was on weakening security code, and getting around it wasn't mine to decide. Direct tests exist for both, but they haven't been seen to fail.
- **Rejected:** Making the same temporary edits through a shell command.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), Testing section

### 2026-11-05 Close #8 with tasks moved to other issues

- **Decision:** PR #81 closed #8 (outbound handlers) even though some of its tasks moved to #79 (container proof) and #11 (stop, blocked, resume). The moved tasks are noted in #8's checklist.
- **Why:** The split was approved, and leaving #8 open would show work as outstanding that's tracked elsewhere.
- **Rejected:** `Refs #8` until #79 finished.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), #8 (outbound handlers)

### 2026-11-05 Start the log with today's decisions only

- **Decision:** The log begins at #8 (outbound handlers). Earlier decisions stay in ADRs and in issue and PR comments.
- **Why:** Reconstructing older decisions from memory would produce entries nobody can check.
- **Rejected:** Backfilling from the whole project's history.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #82
- **Evidence:** PR #82 (start a decision log)

### 2026-11-05 Try the log here before adding it to `claude-shared`

- **Decision:** The standard lives in this repo for now. It moves to `claude-shared` after use on #79 (container proof) and #9 (agent CLI in a sandbox).
- **Why:** It would apply to every repo, and the rule for what to log has already changed once.
- **Rejected:** Adding it to `claude-shared` now.
- **Decided by:** Claude
- **Approved by:** None. danjamk said it probably belongs in both and hasn't ruled on the timing
- **Evidence:** PR #82 (start a decision log), Next Steps

### 2026-11-05 Log in-process decisions, including rejected recommendations

- **Decision:** The log now covers any choice someone might later wonder about, including small ones an agent makes along the way. `Approved by: None` is a normal value. A rejected recommendation gets its own entry, whoever rejects it. Logging doesn't change what agents may decide alone. This replaces the stricter test in "Keep a decision log".
- **Why:** The first test would have left out the small calls people want to look back on, and agent collaboration or evaluation could add agents that turn down recommendations.
- **Rejected:** Adding a field for rejections, because an entry that names what was rejected already covers it.
- **Decided by:** danjamk asked for the wider scope; Claude chose the wording and the rejection format
- **Approved by:** danjamk asked for the scope in the working session; the wording and format are claims until danjamk merges this PR
- **Evidence:** This entry's PR, `standards/decision-log.md`

### 2026-11-05 Intercept only listed hosts

- **Decision:** A run intercepts HTTPS for GitHub, the model hosts and the repo's registries by name, with no `*` and no plain HTTP. This replaces the #8 plan to intercept all HTTP and HTTPS.
- **Why:** With `*`, every hostname resolves, so DNS could carry data out and #79's DNS check couldn't pass. The cost is that a request to an unlisted host fails inside the container and isn't logged.
- **Rejected:** Intercepting everything, which logs every attempt with a reason.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/src/sandbox.ts`

### 2026-11-05 Run the container from RunState, driven by an alarm

- **Decision:** The existing `RunState` Durable Object owns the run's container. The release returns a 202 at once, and an alarm checks the run every 10 seconds until it finishes.
- **Why:** That's one object per run, and `RunState` held no data yet. A running process doesn't keep a container alive, and GitHub gives up on a webhook after 10 seconds.
- **Rejected:** A new Durable Object class for the container, and waiting for the probe inside the webhook call.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/src/run.ts`

### 2026-11-05 Tear down on every exit, and post container output as untrusted

- **Decision:** Every way a run ends goes through one step that destroys the container, posts the result and stops the run. The posted output has credentials scrubbed, a length cap and no way to close its code block.
- **Why:** `exec` has no timeout of its own, and the output comes from code the orchestrator doesn't trust.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/test/run.test.ts`

### 2026-11-05 Make the probe open a PR and aim its denials at fake ids

- **Decision:** Besides cloning and pushing, the probe opens a draft PR, marks it ready and comments on the issue. Checks that should be denied target the testbed or fake ids. Each run leaves a branch, a PR and a comment on the testbed.
- **Why:** #9 (agent CLI in a sandbox) depends on the PR path. If a filter fails, GitHub returns an error instead of changing anything.
- **Rejected:** Only clone and push, as #79 first said.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/container/probe.sh`

### 2026-11-05 Merge the container code first, then prove it live

- **Decision:** The container code merges with `Refs #79`, the CI deploy builds the image, and a later docs PR records the live probe and closes #79. The deploy tries the current token first, so the docs record the permissions it actually needs.
- **Why:** Deploys run only from `main`, which is the same pattern as #75 (CI deploy). No document states the token permissions.
- **Rejected:** Deploying a branch by hand, which skips review and the approval step.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof)

### 2026-11-05 Set the run limit to 12 minutes

- **Decision:** A run is stopped after 12 minutes. The proposal said 10.
- **Why:** The probe's network checks each wait up to 20 to 30 seconds for a failure, and they add up close to 10 minutes on a slow instance.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `RUN_LIMIT_MS` in `orchestrator/src/run.ts`

### 2026-11-05 Build the image on Debian slim with git, curl and jq

- **Decision:** The image is `debian:trixie-slim` pinned by digest, with `ca-certificates`, `curl`, `git` and `jq`. The proposal named only `git` and `curl`.
- **Why:** `jq` lets the probe build and read JSON safely, instead of by string matching. Debian's packages aren't pinned, so a rebuild picks up security updates.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/container/Dockerfile`

### 2026-11-05 Trust the platform CA through environment variables

- **Decision:** The probe gets `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`, all pointing at the platform's CA. The system trust store isn't changed.
- **Why:** Every HTTPS request is intercepted, so that CA is the only one needed. This needs no step that writes to the trust store at startup.
- **Rejected:** Merging the CA into the system bundle, which Cloudflare's docs also describe.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `probeEnv` in `orchestrator/src/sandbox.ts`

### 2026-11-05 Name a run by its delivery id

- **Decision:** Each accepted release starts a run named by the webhook's delivery id. Relabeling an issue starts a second run.
- **Why:** It's the simplest unique name, and stopping a second run per issue is a #9 (agent CLI in a sandbox) task.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `startRun` in `orchestrator/src/webhook.ts`

### 2026-11-05 Ignore a release with no repo id or default branch

- **Decision:** The webhook now requires `repository.id` and `repository.default_branch`. A payload without them is ignored with a reason, like other non-releases.
- **Why:** The run's token is minted by repo id, and the PR's base must be the default branch.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `decide` in `orchestrator/src/webhook.ts`

### 2026-11-05 Remove the token mint by repo name

- **Decision:** `mintInstallationToken`, which limited a token by repo name, is gone. Runs use `mintRunToken`, which limits it by repo id.
- **Why:** Nothing calls it once releases start runs, and a leftover helper looks like the right one to use.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/github.ts`

### 2026-11-05 Drop the test for retrying a failed release

- **Decision:** The webhook test that forced a token failure and redelivered is removed. The webhook no longer mints, so that failure can't happen there. The code that forgets a delivery when starting a run fails is still there, but no test covers it.
- **Why:** I didn't find a way to make the Durable Object call fail in the test pool without a test-only hook in the Worker.
- **Rejected:** Adding a test-only setting to the Worker.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/test/webhook.test.ts`

### 2026-11-05 Keep running the probe after a failed clone

- **Decision:** If the clone fails, the probe records one failure for the push checks and carries on with the API and credential checks.
- **Why:** The first local run stopped at the failed clone, so the rest of the checks never ran.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/container/probe.sh`

### 2026-11-05 Add Containers Edit to the factory deploy token

- **Decision:** `saw-factory-cloudflare-deploy-token` gets the account permission Containers Edit, besides Workers Scripts Edit and Account Settings Read.
- **Why:** The first deploy with the container failed at `GET /accounts/<account>/containers/me` with no reason given. The same deploy passed once the permission was added. The live Worker didn't change while it failed.
- **Rejected:** A broader token, such as the "Edit Cloudflare Workers" template.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, by adding the permission in the dashboard
- **Evidence:** Failed `orchestrator-deploy` run 42126043401, then the rerun that passed

### 2026-11-05 Register a run's intercepts once per container

- **Decision:** A run registers its intercepts the first time it sees its container, and again only if the Durable Object restarts. It used to register them on every 10-second check.
- **Why:** In the first live probe, the call that opens the PR waited 10.3 seconds and got a 502, and GitHub accepted the same PR in 1.7 seconds when sent directly. The likeliest cause is re-registering while that request was in flight, even though Cloudflare's docs say that doesn't drop connections. The second live run tests this.
- **Rejected:** Retrying the call in the probe, which would hide the cause from an agent too.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/run.ts`, the first probe's comment on agent-testbed #34

### 2026-11-05 Log failures and slow responses from upstream

- **Decision:** The outbound handler logs the host, method, status and time of any upstream response that's a 5xx or takes over 5 seconds, with no path or body.
- **Why:** The platform's log shows only what the handler returned, so the first probe's 502 couldn't be traced to upstream or to the Worker.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `send` in `orchestrator/src/outbound/handler.ts`

### 2026-11-05 Judge a request with no body by its route

- **Decision:** An empty body passes to the route rules instead of being refused as bad JSON.
- **Why:** A `DELETE` of `agent:stop` was refused as "bad body". It was still denied, but for the wrong reason, which makes a denial log misleading.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `readJson` in `orchestrator/src/outbound/handler.ts`

### 2026-11-05 Close #79 with the 502's cause unconfirmed

- **Decision:** #79 (container proof) closes on three live runs: 40 of 42, then 42 of 42 twice. The first run's 502 on opening the PR isn't explained for certain.
- **Why:** The second run passed on the same build, so the failure comes and goes. The third, with intercepts registered once, passed too. The handler now logs upstream 5xx, so a repeat during #9 would show its source. Keeping #79 open wouldn't produce more evidence.
- **Rejected:** More probe runs to try to reproduce it.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/README.md`, Live results: the outbound probe

### 2026-11-05 Use Claude Code as the first agent CLI

- **Decision:** The agent runner is Claude Code, pinned at 2.1.309. Other CLIs follow as more runner modules.
- **Why:** It was the recommended first CLI in spec 0001, and the approver's own sessions use it.
- **Rejected:** Codex first, or two CLIs at once.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "use Claude Code as the agent" in the working session
- **Evidence:** #9 (agent CLI in a sandbox), PR for #9

### 2026-11-05 Post one status comment per run

- **Decision:** The orchestrator posts a comment when a run starts and edits it when the run ends. There's no running label and no board move.
- **Why:** The issue showed nothing between release and the agent's first push. ADR-005 keeps run state out of labels, and the App can't write to a user-owned project.
- **Rejected:** An `agent:running` label, and a new comment for each event.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "Add it" in the working session
- **Evidence:** [#9 comment](https://github.com/danjamk/secure-agent-workflow/issues/9#issuecomment-6672945291)

### 2026-11-05 Keep the model key as a Worker secret, set by hand

- **Decision:** `ANTHROPIC_API_KEY` is a secret on the Worker, set in the Cloudflare dashboard. It isn't in the AWS broker, and the CI deploy never holds it.
- **Why:** It's a runtime secret, like the App key, and those stay out of the deploy job. The container never gets it: the outbound handler adds it.
- **Rejected:** The broker, which would put the key in the deploy job's environment. A `wrangler secret put` command, which needs a one-day Cloudflare token for a step the dashboard does directly.
- **Decided by:** Claude proposed a hand step; danjamk chose the dashboard
- **Approved by:** danjamk, set the secret in the dashboard
- **Evidence:** `orchestrator/README.md`, Credentials

### 2026-11-05 Use an API key, not Anthropic's identity federation

- **Decision:** The Worker uses a static Anthropic API key.
- **Why:** Identity federation takes tokens from GCP, AWS, Azure or GitHub Actions, and a Cloudflare Worker has none of those. Signing our own tokens would make the signing key the static secret instead. Revisit if Cloudflare gains workload identity or Anthropic accepts other issuers.
- **Rejected:** Identity federation.
- **Decided by:** Claude
- **Approved by:** danjamk, by creating the key
- **Evidence:** The Anthropic Console's key dialog, 2026-11-05

### 2026-11-05 Cap the key's spend and expire it after 90 days

- **Decision:** The organization's monthly spend limit is $50 with an alert at $20. Claude recommended a 90-day expiry for the key.
- **Why:** $50 covers at least 10 runs at the $5 per-run estimate during the pilot. 90 days makes the hand rotation rare, while a key that never expires can leak unnoticed. Nothing reminds the operator before it expires.
- **Rejected:** No expiry, and 30 days.
- **Decided by:** danjamk set the limits; Claude recommended the expiry
- **Approved by:** danjamk set the spend limit. Which expiry was set isn't recorded
- **Evidence:** The Anthropic Console

### 2026-11-05 Run Claude Code headless with prompts off and vendor-run tools off

- **Decision:** Claude Code runs with `-p`, stream-json output to a file, `--dangerously-skip-permissions` as a non-root `agent` user, 200 turns, a $5 estimate, and web search and web fetch turned off. Telemetry, error reports, auto-update and feedback are off. The main model is `claude-sonnet-5-5`, and background work uses `claude-haiku-5-5`.
- **Why:** The container is the control, so prompts would only stall the run. Claude Code refuses to skip prompts as root. Each turned-off feature would try a host the container can't reach.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/agents/claude-code.ts`, `orchestrator/container/run-agent.sh`

### 2026-11-05 Give the agent an agent-gh helper instead of gh

- **Decision:** The image has an `agent-gh` command for the agent's GitHub writes, made as plain REST and GraphQL calls, and no `gh` CLI.
- **Why:** `gh` makes PR and comment writes through GraphQL mutations the policy refuses. The helper uses only calls the policy allows.
- **Rejected:** Opening those `gh` mutations in the policy.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/container/agent-gh`

### 2026-11-05 Keep the probe as a second runner, picked by agent:probe

- **Decision:** CLI-specific code lives in `src/agents/`. The probe stays as a second runner, picked when an issue also has `agent:probe`, which bootstrap now creates.
- **Why:** Two runners show that adding a CLI touches one module. Keeping the probe lets anyone recheck the policy after a change.
- **Rejected:** Dropping the probe now that the agent runs.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/agents/`

### 2026-11-05 Hold one run per issue in the delivery log

- **Decision:** A table in `DeliveryLog` holds each issue's active run. A second release while one is active is ignored. A claim older than two hours counts as stale and is replaced.
- **Why:** That object is already the strongly consistent store for releases. The two-hour limit covers a run that died without reaching teardown.
- **Rejected:** Naming the run's Durable Object by issue, which would carry one run's state into the next.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/deliveries.ts`

### 2026-11-05 Pass files into the container as arguments

- **Decision:** The Worker writes each file by passing its content as a base64 argument to `sh`, which decodes it to the path. The issue body is cut at 60,000 characters.
- **Why:** Nothing in the content reaches a shell as code. An argument is capped at 128 KiB on Linux, and the cut keeps the issue under it.
- **Rejected:** Streaming the content on stdin, which I couldn't test without the platform.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `writeFile` in `orchestrator/src/run.ts`

### 2026-11-05 Bundle the agent instructions into the Worker

- **Decision:** A wrangler Text rule bundles `standards/agent-instructions.md` into the Worker, which writes it into each container. That reaches across folders, so it's named in the orchestrator's contract.
- **Why:** The standards README says the orchestrator puts the instructions in the sandbox. Bundling means a run always gets the instructions from the deployed commit.
- **Rejected:** Copying them into the image, which Docker can't do from outside the `container/` build folder. Fetching them at run time, which adds a call that can fail.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/wrangler.jsonc`, `orchestrator/src/agents/claude-code.ts`
