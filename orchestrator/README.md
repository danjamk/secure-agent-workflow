# Orchestrator

A Cloudflare Worker in the factory account that starts a sandbox per released issue (ADR-004). It's built in steps, and this is what exists today:

| Built | Not built yet |
| --- | --- |
| `/health`, webhook intake, the release checks, delivery dedupe, installation tokens, the outbound policy, a container per run that runs Claude Code or the outbound probe, one status comment per run, stop, blocked and resume, model spend budgets, a redacted log per run | Serving the logs (#101), the coordinator (#13) |

## A run

An accepted release starts a run, named by the delivery id. An issue has one active run at a time, so relabeling while a run is live doesn't start a second. A runner module (`src/agents/`) decides what the run does:

| Runner | Picked when | What it runs |
| --- | --- | --- |
| `claude-code` | By default | Claude Code 2.1.309, headless, as the `agent` user on a `standard-1` instance. Limited to 60 minutes, 200 turns and its own $5 estimate |
| `probe` | The issue also has `agent:probe` | `container/probe.sh`, which tries what an agent might and reports what got through (#79). Use it to recheck the policy after changing it. Limited to 12 minutes, on a `lite` instance |

Adding an agent CLI is a new module in `src/agents/` and one line in `RUNNERS`.

The `RunState` Durable Object owns the run, and an alarm checks it every 10 seconds:

1. Post the run's status comment on the issue.
2. Register the intercepts, then start the container with `enableInternet: false`.
3. Wait for the platform's CA, which appears once HTTPS is intercepted. Then write the runner's files and start its command. For the agent, the files are the issue's title and body, `standards/agent-instructions.md`, and `standards/decision-log.md`, which says how to add each decision as its own file in `docs/decisions/`. Both standards are bundled into the Worker, so a change to them reaches agents with the next deploy. The command's output goes to a file, because a process with piped output gets `SIGPIPE` when the call that started it ends.
4. When the command exits, destroy the container, edit the status comment with the result, release the issue and stop the run, which revokes its token.

Every way out goes through step 4: the command finishing, the container stopping on its own, an error, or the time limit. For the agent, the result is Claude Code's final result event, because it can exit 0 after a failed model request. The output comes from the container, so it's treated as untrusted: credentials are scrubbed, the length is capped and it can't close its code block.

Inside the container:

- `run-agent.sh` clones the repo, sets the App's bot as the commit author and runs Claude Code with a fixed prompt that points at the files. The issue reaches the agent only as a file.
- `agent-gh` makes the GitHub writes the agent needs: open its draft PR, edit it, mark it ready, turn on auto-merge, comment, and add `agent:blocked`. The `gh` CLI isn't installed, because it makes these writes through GraphQL calls the policy refuses.
- Claude Code's `Co-Authored-By` commit trailer is off, in the image's managed settings, which a repo's own settings can't override.
- Claude Code's web search and web fetch are off, along with its telemetry, error reports, auto-update and feedback, each of which would try a host the container can't reach.
- A repo's own `.claude/settings.json` hooks and `.mcp.json` servers run too, without a prompt. They stay inside the container, and an MCP server can reach only the allowed hosts.

Each probe run leaves a branch, a PR and a comment on the testbed's issue. Remove them by hand.

## Stop, blocked and resume

Only the approver's login, on a user account, can do any of these. The agent App can add labels and comment too, and those are ignored.

| Event | What happens |
| --- | --- |
| The approver adds `agent:stop` or removes `agent:ready` | The run writes its stop flag first, so the outbound policy refuses every request after that. Then it revokes its token, destroys the container, edits the status comment and comments on the PR. Requests already in flight, such as a streaming model response or a push, can finish, and their charges stand. A stop is final: removing the label restarts nothing. It also clears a blocked issue |
| The agent adds `agent:blocked` and exits | The policy records the label when it gets through. The run ends as blocked and saves the branch and PR |
| The run hits its time limit | It ends as blocked, and the orchestrator adds `agent:blocked`. Work it didn't push is lost |
| A model call would go over a budget | The policy refuses it and the run ends as blocked, with the budget named. A reply resumes a run that spent its own budget. One that spent the issue's or the month's can't be resumed (Model spend) |
| The approver comments on a blocked issue or its PR | A fresh run starts with the branch and PR pinned, removes `agent:blocked`, and gets the reply as `reply.md` |
| Anyone removes `agent:blocked` | Nothing. Only a reply resumes a run |
| A new `agent:ready` | Starts over, and a blocked run from before can't be resumed |

A release gets 3 runs: the first and two resumes. After the third, the status comment says a reply won't resume it, and the approver adds `agent:ready` to start again. Model spend is capped per run, per release and per month (Model spend).

## Outbound policy

The container starts with `enableInternet: false`, and the run intercepts HTTPS for these hosts only. Every request to them reaches the `Outbound` entrypoint (`src/outbound/handler.ts`), and other names don't resolve, so DNS can't carry data out. There's no plain HTTP intercept. Each request is denied unless a rule below allows it. The stop flag and the HTTPS check come first.

A request to a host that isn't listed fails inside the container and never reaches the Worker, so it isn't logged.

| Host | Allowed | Credential |
| --- | --- | --- |
| `github.com` | Git for this run's repo: `info/refs`, `git-upload-pack`, `git-receive-pack`. A push must be one ref, on the run's branch, and not a deletion | Installation token |
| `api.github.com`, REST | Reads under the run's repo. Writes: create the run's one PR, edit its title and body, comment on its issue or PR, add `agent:blocked` to its issue | Installation token |
| `api.github.com`, GraphQL | Queries. One `markPullRequestReadyForReview` or `enablePullRequestAutoMerge` per request, on the run's PR | Installation token |
| `api.anthropic.com` | The message endpoints, for models in `ALLOWED_MODELS` that have a price. No vendor-run tools or URL inputs, because those make the vendor reach another host. Each charged call is metered (Model spend) | The vendor's key. Unset means denied |
| `api.openai.com` | Nothing yet. The handler can't read OpenAI's usage, so its calls can't be metered | The vendor's key |
| Hosts in `EGRESS_HOSTS` for this repo | GET and HEAD. `github.com` here allows release downloads only | None |

How the rules hold up:

- **Run scope.** The orchestrator passes the run's repo, issue and default branch as the entrypoint's props, which the container can't read or change. The `RunState` Durable Object holds what's set during the run: the stop flag, the branch and the PR. The first ref pushed becomes the branch, and the PR's number and node ID come from GitHub's response.
- **Repo id.** The token is minted for the immutable repo id, so renaming a repo can't point it at another.
- **What's forwarded.** The URL is rebuilt, headers come from a short list, and each write's JSON is rebuilt from what was checked. So `Authorization`, `Cookie`, `X-HTTP-Method-Override`, a repeated JSON key and an encoded path don't reach GitHub.
- **Redirects.** They're never followed. One from a call with a credential comes back as a 502, because its `Location` can hold a signed URL.
- **Force-pushes.** A push's ref commands can't show one, so the `agent-branches` ruleset blocks them (`bootstrap/README.md`).

Known limits:

- A commit message like `Fixes #99` can close another issue when the PR merges. The policy blocks this in PR titles and bodies, and #13 treats a blocker closed by an agent's PR as still open.
- A registry read can carry data in its path. It reaches only the registry's own logs, and the list is per repo for that reason.
- Concurrency across runs is the coordinator's (#13).

## Run logs

Each run keeps its own log in its `RunState` Durable Object (#10). On every check, the run reads what the agent's event stream (`events.jsonl`) and the runner script's output (`run.log`) gained since the last check. It redacts that, then stores it. Nothing unredacted is stored.

- **Whole lines only.** A line is stored once its newline arrives, so a credential can't be split across two reads and slip past redaction. A line over 256KB is split at a space, quote or comma, which a credential can't contain. The last line is taken when the run ends, newline or not.
- **Redaction.** First, the exact value of every credential the Worker holds: the App's private key, whole and line by line, the webhook secret, the model keys, every token minted for the run, and each token in git's Basic auth form. Each is matched as it is and JSON-escaped, since the event stream is JSON. Then, patterns for common token formats: GitHub tokens, `sk-` and `sk-ant-` keys, AWS key ids, JWTs, Basic auth and PEM private keys. The status comment's output goes through the same redaction.
- **Size.** At most 10 MB per run. After that, the log ends with a line saying it was cut, and the run reads no more.
- **Retention.** 30 days after the run ends, its Durable Object deletes everything it holds, the log included. It keeps one flag, so the same delivery can't start the run again.
- **Status comment.** It ends with the number of lines stored, the number of credentials removed, and the date the log will be deleted.
- **Reading it.** `GET /api/runs/<run>/log`, for the operator only (Operator routes).

## Operator routes

`/api/*` serves the operator, through the console Worker (#105) on its own `workers.dev` hostname, behind Cloudflare Access (ADR-010, revised for no custom domain). The console forwards each request over a service binding with the `Cf-Access-Jwt-Assertion` header Access added. The orchestrator checks that token itself on every `/api/*` request, before matching the path, so the console holds no authority, and an unauthenticated caller can't tell which paths exist.

| Check | Rule |
| --- | --- |
| Signature | RS256 only, against the team's keys from `https://<ACCESS_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`, cached for 10 minutes. An unknown key id refetches them, at most once a minute |
| Claims | `aud` includes `ACCESS_AUD`, `iss` is the team's, `exp` hasn't passed, and `nbf` has, within 30 seconds |
| Identity | `email` equals `OPERATOR_EMAIL`, ignoring case. A service token has no email, so it's refused |
| Settings | `ACCESS_TEAM`, `ACCESS_AUD` and `OPERATOR_EMAIL` are Worker variables. Any one empty refuses every request. `deploy.sh` passes them when they're set; they aren't committed |

Anything that fails gets a 403 with no reason. The reason goes to the Worker's log, never the token.

| Route | Returns |
| --- | --- |
| `GET /api/runs/<run>/log` | The run's stored, redacted log as `text/plain`, with `nosniff`, `default-src 'none'` and `no-store`, so the browser shows it as text and keeps no copy. 404 if the run has none |

The orchestrator's own `workers.dev` hostname has no Access, so `/webhook` stays reachable by GitHub, and `/api/*` there gets 403.

## Model spend

Every charged model call is reserved before it's sent and settled after (#92, R3 in `docs/research/design-review-2026-11-01.md`). The settings are Worker variables in `wrangler.jsonc`:

| Setting | Default | What it does |
| --- | --- | --- |
| `MODEL_PRICES` | Sonnet 5.5 and Haiku 5.5 | Dollars per million tokens for input, output, 5-minute and 1-hour cache writes, and cache reads. A model with no price is refused. Haiku is priced at its rate for prompts over 100K tokens, so it has one price |
| `RUN_BUDGET_USD` | 5 | One run |
| `ISSUE_BUDGET_USD` | 8 | A release and its resumes. A new `agent:ready` starts it over |
| `MONTHLY_BUDGET_USD` | 15 | A UTC calendar month, across all runs. A run doesn't start unless the month has a full run budget left |
| `MAX_OUTPUT_TOKENS` | 32000 | The largest `max_tokens` a call may ask for. Claude Code gets the same value as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |

An unset or invalid budget is $0, which refuses every charged call.

- **Before a call.** The policy refuses a call with no `max_tokens`, one over the ceiling, and one that sets `speed`, `inference_geo` or `service_tier` to anything but the standard price. It reserves the worst case: the body's bytes at the dearest input rate, since a token is at least a byte, plus `max_tokens` at the output rate. The reservation has to fit the run's, the issue's and the month's budgets, counting calls still in flight. `DeliveryLog` holds the ledger, and one instance serves the deployment, so two calls can't both take the last of a budget.
- **After a call.** The response passes through unchanged. Its usage, from the JSON body or from the stream's `message_start` and final `message_delta`, settles the reservation. An error response settles to $0. A stream that's cut off before `message_stop`, a body with no usage, or a failed send keeps the whole reservation, because whether it was billed isn't known.
- **Reporting.** The status comment ends with the run's calls, tokens and cost.
- **What it costs.** A large context holds a large reservation while the call runs: a 600KB request holds about $2.70, even when cache reads make it cost a few cents. So the last few dollars of a run can't start a large call.
- **What it doesn't cover.** `count_tokens` is free and isn't metered. Container and Worker costs aren't counted here. The Anthropic workspace spend limit stays the backstop.

## What counts as a release

The Worker acts on a webhook only if all of these hold. Anything else gets a 200 with the reason in the body, which shows in the App's delivery log.

- The `X-Hub-Signature-256` signature matches the raw body.
- The event is `issues.labeled` with the label `agent:ready`.
- The sender is `APPROVER_LOGIN` and is a user account. The agent App has `issues: write`, so it can add this label too; that's ignored (ADR-005).
- The repo is in `ALLOWED_REPOS`.
- The issue is open.
- This delivery id hasn't been accepted before.

An empty `APPROVER_LOGIN` or `ALLOWED_REPOS` means nothing is released, and a missing webhook secret means every webhook gets a 500.

If starting the run fails, the Worker returns a 502 and forgets the delivery id, so redelivering it from the App's delivery log tries again. A failure after that is reported on the issue.

## Contract with the sandbox

#79 and #9 have to keep to this.

| | |
| --- | --- |
| Goes in | The issue's title and body and `standards/agent-instructions.md`, as files in `/workspace/task`, and a clone over HTTPS |
| Comes out | Commits on `agent/<issue>-<slug>`, a PR, issue and PR comments, the `agent:blocked` label, and the run's log |
| Never enters | The App private key, the webhook secret, installation tokens and model API keys. The outbound handler adds tokens and keys to each request |
| Network | Deny by default. HTTPS to the listed hosts reaches the policy. Nothing else resolves or connects |

## Contracts with other components

| Component | What the orchestrator expects |
| --- | --- |
| `bootstrap/github-app/` | An App with the permissions in its README, and its id, private key and webhook secret in the Keychain until `connect-app.sh` copies them |
| `bootstrap/` | The `agent:*` labels and the `agent-branches` ruleset on each repo, and the `factory` environment on this one |
| `deploy/broker/aws/` | The deploy token and settings, through the broker action |
| `standards/agent-instructions.md` | The branch pattern, labels and PR format |
| `gate/` | Nothing directly. The gate judges the PR the agent opens |

## Credentials

| Item | Where it lives | Set by |
| --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret, PKCS#8 | `connect-app.sh` |
| `GITHUB_WEBHOOK_SECRET` | Worker secret | `connect-app.sh` |
| `ANTHROPIC_API_KEY` | Worker secret, set in the dashboard: Workers & Pages → `saw-orchestrator` → Settings → Variables and Secrets. Or with `wrangler secret put`. The key is `saw-factory-anthropic-api-key` in the Anthropic Console, expires after 90 days and sits under a monthly spend limit. Nothing reminds you before it expires | The operator, by hand |
| `OPENAI_API_KEY` | Worker secret, optional and not set. A model host with no key is refused | The operator, by hand |
| Installation tokens for runs | In memory in `RunState`, and never in storage. Revoked on stop | Minted on demand, replaced with 10 minutes left |
| `saw-factory-cloudflare-deploy-token` | The broker, read only by the `factory` environment's role | The operator, with `broker.sh set-factory`. This account is never a deploy target for an app, and `broker.sh set` refuses this token |

## Deploying

CI deploys this on merge to `main`, after the owner approves the run. `.github/workflows/orchestrator-deploy.yml` checks that `/health` matches the commit. `deploy/README.md`, Factory deploys, has the setup and which changes start a deploy.

The account, the Worker's URL and the repo list stay out of committed files and out of the logs.

`wrangler deploy` builds `container/Dockerfile` for `linux/amd64` and pushes it to Cloudflare's registry, so it needs Docker. GitHub's Ubuntu runners have it. The deploy token needs Containers Edit for the push. Without it, the first Containers API call fails with no reason given, before the Worker changes.

### Deploying by hand

Two jobs need a token on your machine: setting Worker secrets, which CI never does, and an emergency deploy when CI is down. No long-lived token stays on disk for either.

1. Create a Cloudflare token in the factory account with Workers Scripts Edit, Containers Edit, Account Settings Read and a TTL of one day.
2. Put it in this shell only, from a clean checkout. `.env.local` needs `CLOUDFLARE_ACCOUNT_ID`, `APPROVER_LOGIN`, `ALLOWED_REPOS` and `ORCHESTRATOR_URL`.
3. Run what you need, then revoke the token.

```bash
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
make -C orchestrator connect   # copies secrets, points the App's webhook at the Worker
make -C orchestrator deploy    # emergency only: this skips the approval
make -C orchestrator health    # checks the live Worker matches this checkout
```

Rerun `connect` when the App's private key or webhook secret changes. A new setup also runs `deploy` once by hand first, because `connect` needs the Worker to exist and the first run prints its URL.

## Tests

```bash
make -C orchestrator check           # typecheck and every test
make -C orchestrator test-security   # who can release an issue, and what a run can reach
```

Tests run in the Workers runtime through `@cloudflare/vitest-plugin`, with a real Durable Object. Only GitHub is stubbed. Each run generates its own throwaway RSA key.

The plugin turns containers off. `test/run.test.ts` drives a run against a fake container, and the live results below are the proof against the real one. To check the probe script itself, build the image and run it with networking off: every denial should pass and every allowed call should fail.

```bash
docker build --platform linux/amd64 -t saw-agent orchestrator/container
docker run --rm --platform linux/amd64 --network none -e REPO=a/b -e ISSUE=1 -e SLUG=probe-test -e DEFAULT_BRANCH=main saw-agent /agent/probe.sh
```

### Live results

2026-11-04, deployed to the factory account, on the two testbeds. Status and reason come from the App's delivery log.

| Case | Status | Reason in the response |
| --- | --- | --- |
| Approver adds `agent:ready` to an open issue on an allowed repo | 202 | Released, and the App commented on the issue |
| The same delivery sent again | 200 | `duplicate delivery`, with no second comment |
| The agent App adds `agent:ready` | 200 | `sender isn't the approver` |
| Approver adds `agent:blocked` | 200 | `another label` |
| Approver adds `agent:ready` on a repo outside `ALLOWED_REPOS` | 200 | `repo isn't allowed` |
| Approver adds `agent:ready` to a closed issue | 200 | `issue isn't open` |
| Approver removes `agent:ready` | 200 | `action unlabeled` |
| The App's own comment comes back as an event | 200 | `event issue_comment`, so comments don't loop |
| Unsigned POST to `/webhook` | 401 | Sent directly, not by GitHub |

The Worker never exposes the token, so the live test didn't observe its scope or its revocation. Tests cover both. The comment was posted, and the Worker only reaches that step after checking the token lists exactly one repo.

### Live results: the outbound probe

2026-11-05, three runs on agent-testbed #34. Each run's full output is in its comment on that issue.

| Run | Build | Result |
| --- | --- | --- |
| 1 | `0.1.7+67a171a` | 40 of 42. Opening the draft PR waited 10.3 seconds and got a bare 502, so marking it ready failed too. GitHub accepted the same PR in 1.7 seconds when sent directly |
| 2 | `0.1.7+67a171a` | 42 of 42, on the same build |
| 3 | `0.1.8+42ec012` | 42 of 42, after intercepts were registered once per container |

What run 3 showed:

| Area | Checks | Result |
| --- | --- | --- |
| Network | A blocked host over HTTPS and HTTP, a bare IP over both, the metadata address, raw TCP to port 22, DNS for an unlisted name, plain HTTP to `github.com`, another GitHub host | All failed. Unlisted names timed out, and `github.com` resolved to a placeholder address |
| Git | Clone and two pushes to the run's branch | Worked |
| Git | Clone another repo, push to `main`, a second branch, another issue's branch, a tag, delete the branch | Refused by the policy with a 403 |
| Git | Force-push the run's branch | Refused by GitHub: "push declined due to repository rule violations". The testbed's ruleset log names `agent-branches`, "Cannot force-push to this branch" |
| GitHub API | Read the issue, open the draft PR, comment on the issue, mark the PR ready, a GraphQL read | Worked |
| GitHub API | Comment on another issue, a review, a merge, closing a blocker from the PR body, removing `agent:stop`, adding `agent:ready`, closing the issue, moving a ref, reading the installation or another repo, merging or removing a label by GraphQL, a GraphQL batch, a model call with no key | All refused with "Blocked by the outbound policy" and the reason |
| Credentials | The environment, every process's environment, files under `/etc`, `/root`, `/home`, `/tmp`, `/var`, `/opt`, `/usr/local`, and `.git/config` | No credential found |

The cause of run 1's 502 isn't confirmed. Run 2 passed on the same build, so the failure comes and goes. Re-registering intercepts on every check, while a request was in flight, is the likeliest cause, and no failure has occurred since that changed. The handler now logs any upstream 5xx, so a repeat would show where it came from.

Other findings:

- **Deploy token:** it needs Containers Edit. Without it, the first Containers API call failed with no reason, and the live Worker didn't change.
- **Plan:** the deploy and runs worked, so the factory account's plan supports containers.
- **Cost:** a run took about 4 to 5 minutes, judging from the push times and the network checks' timeouts. Container start-up wasn't measured. On a `lite` instance that's well under a cent, by my arithmetic from Cloudflare's pricing, and inside what Workers Paid includes.
- **Cleanup:** each run leaves a branch, a PR and a comment on the testbed. Runs 1 to 3 were cleaned up by hand.

### Live results: the first agent run

2026-11-06, build `0.1.10+0b1b612`, on agent-testbed #38: add a `## Status` section to the README.

| Step | Result |
| --- | --- |
| Release | The approver added `agent:ready`, and the App posted the run's status comment |
| Agent | Claude Code read the issue and the instructions, made one commit as the App's bot, and opened a draft PR with `agent-gh` |
| PR | Tier line, current step, `Closes #38`, a ticked checklist and run notes, as the instructions ask. Marked ready, with auto-merge on |
| Gate | Every check passed, including the tier check for a bot-authored tier 1 PR. The PR squash-merged on its own and closed the issue |
| Result | 7 turns, about $0.05, about 1.5 minutes from label to merge |

Two problems, fixed after the run:

- **`make` wasn't in the image,** so the agent couldn't run `make check`. It said so in its run notes and read the Makefile instead.
- **The result arrived as a second comment** instead of an edit to the status comment, so the run didn't have the start comment's id. The likeliest cause is the 3-second limit on GitHub calls, which dated from when the webhook made them. The limit is now 15 seconds. A run that's missing the id finds its start comment by the run id.

### Live results: stop, blocked and resume

2026-11-06, build `0.1.12+7086bd5`, on agent-testbed. The approver's actions came from the approver's login.

| Test | Result |
| --- | --- |
| Stop, first try (#40) | Not a test: the agent finished in about 35 seconds, before `agent:stop` was added, and the stop found nothing to stop |
| Stop mid-run (#44) | The agent opened its draft PR, then was told to wait. `agent:stop` at 02:19:40 ended the run: the status comment read "Stopped by danjamk", and the run commented on the PR. The branch holds only the commit from before the stop. Removing `agent:stop` started nothing |
| Block (#41) | Asked not to choose a license, the agent pushed a branch, opened a draft PR, asked which license to use with a recommendation, and added `agent:blocked`. The status comment said "run 1 of 3", and how to resume |
| Resume | A reply on the PR started run 2 seven seconds later and removed `agent:blocked`. The agent added the license, marked the PR ready and turned on auto-merge |
| Merge | The PR conflicted with `main`, because both agent runs had created `docs/decisions.md`. After a hand merge, the gate held it at tier 2 (`LICENSE` matches no rule) for the approver |
| Earlier fixes | Each run ended with one status comment, edited, and `make check` ran |

Fixed after the tests:

- The agents' decision log entries didn't follow the format, because the container had only the instructions. The format file is now bundled too.
- The agent called the license PR tier 1. The gate overruled it, and the instructions now say how to work out the tier from the repo's tier map.
- A block before any push saved no resume point. A resume now starts from the default branch in that case.
- Agents' decision log entries conflict with each other. #94 moves the log to one file per decision.

### Live results: model spend

2026-11-06, build `0.1.14+df85e8e`, on agent-testbed. `RUN_BUDGET_USD` was changed in the dashboard for the block tests and set back to 5 after.

| Test | Result |
| --- | --- |
| Normal run (#46) | Finished and opened a PR. The status comment read "Model use: 7 calls, 14 input and 1,902 output tokens, 131,870 read from cache and 25,353 written, $0.11". Claude Code's own estimate was $0.10. The figure matches the token counts at the 5-minute cache write rate, so the responses carried the cache breakdown. No call was refused: Claude Code sends none of the refused price options, and stays under the `max_tokens` ceiling |
| $1 run budget (#48) | Not a test: the repo is small, and the run finished for $0.10. Each call reserves about $0.32 for output, plus its bytes, so a $1 run refuses only once its requests pass about 150KB |
| $0.50 run budget (#50) | The first call was refused before it was sent, so its body is over about 45KB. The run ended blocked: "Blocked: the run's $0.50 model budget is spent", with "Reply on this issue to resume". The agent's log showed the policy's 403. No call was charged |
| Anthropic console | Not verified per run. The console reports cost by day, and the day's figure didn't change while the tests ran, which looks like reporting delay |

Fixed after the tests:

- A budget block didn't add `agent:blocked`, because the finish step took the block flag to mean the agent had added the label itself.
- The agent's first README edit failed because the image had no `python3`. It's installed now.
- An agent commit had Claude Code's `Co-Authored-By` trailer. The image's managed settings (`/etc/claude-code/managed-settings.json`) turn it off. Verified on agent-testbed PR #52: its commit has no trailer, and the agent ran `python3 --version` (3.13.5).

### Live results: run logs

2026-11-06, build `0.1.17+c16ddec`, on agent-testbed #53. The issue had the agent print two fakes generated at random when it ran, one shaped like a GitHub installation token and one like an Anthropic key.

| Check | Result |
| --- | --- |
| Status comment | "Log: 26 lines stored, 4 credentials removed, kept until 2026-12-06." Two removals per fake. My guess is that the event stream carries each command's output twice, but I didn't confirm it |
| GitHub | Neither fake appears in the status comment, testbed PR #54's description, commits or diff, or the PR's comments |
| Stored text | Not read live: nothing serves the log until #101. The tests cover it, including every credential the Worker holds |
| Decision log | The agent wrote its entry as a file in `docs/decisions/`, the layout from #94 |

## Other options for a fork

From the [sandbox bake-off](../docs/research/sandbox-bakeoff.md):

| Option | Trade-off |
| --- | --- |
| E2B | Vendor-neutral, with Firecracker and egress control, and less to build. The fallback if this orchestrator stalls |
| Docker Sandboxes on your own host | The same security model and free, but needs that machine on |
| GitHub Actions runner with Harden-Runner | Free on public repos. Egress blocking is paid on private repos, and model keys sit on the runner |
| Claude Code cloud sessions | Every control built in, but tied to one vendor, and the session acts as a person's GitHub identity |

Replacing the sandbox host keeps the webhook intake and token minting in `src/`. Dropping this folder also means removing `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` from the repo root.
